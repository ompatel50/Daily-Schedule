"use client";

import * as React from "react";
import { Barcode, Camera, CameraOff, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { lookupBarcodeAction, type FoodResultView } from "@/server/actions/food-search";

/**
 * Barcode scanning for the food search, with no dependency and no upload:
 * the native `BarcodeDetector` API decodes frames entirely inside the browser,
 * so no image or camera frame ever leaves the device — only the digits go to
 * the barcode lookup, exactly as if they had been typed.
 *
 * The camera starts only from a direct click on "Start camera", never on
 * mount or on the dialog opening, and every track is stopped the moment the
 * dialog closes. Browsers without `BarcodeDetector` or a camera get the same
 * lookup through manual entry.
 */

/** The minimal slice of the (not yet in TypeScript's DOM lib) native API. */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** Retail food codes only — EAN/UPC. A QR code is not a product. */
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const BARCODE_PATTERN = /^\d{8,14}$/;
const DETECT_INTERVAL_MS = 250;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === "function" ? (ctor as BarcodeDetectorCtor) : null;
}

function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

type CameraPhase = "idle" | "starting" | "scanning" | "denied" | "failed";

export function BarcodeScannerButton({ onFound }: { onFound: (food: FoodResultView) => void }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Barcode /> Scan barcode
      </Button>
      {/* Mounted only while open, so unmount cleanup is a second guarantee the
          camera never outlives the dialog. */}
      {open && (
        <BarcodeScannerDialog
          onClose={() => setOpen(false)}
          onFound={(food) => {
            setOpen(false);
            onFound(food);
          }}
        />
      )}
    </>
  );
}

function BarcodeScannerDialog({
  onClose,
  onFound,
}: {
  onClose: () => void;
  onFound: (food: FoodResultView) => void;
}) {
  const detectorSupported = React.useMemo(() => barcodeDetectorCtor() !== null, []);
  const cameraSupported = React.useMemo(() => cameraAvailable(), []);
  const scanSupported = detectorSupported && cameraSupported;

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const detectorRef = React.useRef<BarcodeDetectorLike | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const detectBusyRef = React.useRef(false);

  const [phase, setPhase] = React.useState<CameraPhase>("idle");
  const [manual, setManual] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [looking, startLookup] = React.useTransition();

  const stopCamera = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Stopping every track is what turns the camera light off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    detectorRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // The dialog unmounting must never leave the camera running.
  React.useEffect(() => stopCamera, [stopCamera]);

  const lookup = React.useCallback(
    (code: string) => {
      setMessage(null);
      startLookup(async () => {
        const response = await lookupBarcodeAction(code);
        if (response.food) {
          onFound(response.food);
          return;
        }
        setMessage(
          response.notice
            ? `${response.notice.label}: ${response.notice.message}`
            : `No product with barcode ${code} was found. You can add it as a custom food instead.`,
        );
      });
    },
    [onFound],
  );

  const detectFrame = React.useCallback(async () => {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || detectBusyRef.current || video.readyState < 2) return;
    detectBusyRef.current = true;
    try {
      const found = await detector.detect(video);
      const code = found
        .map((barcode) => barcode.rawValue.trim())
        .find((value) => BARCODE_PATTERN.test(value));
      if (code) {
        stopCamera();
        setPhase("idle");
        setManual(code);
        lookup(code);
      }
    } catch {
      // A frame that fails to decode is just the next frame's problem.
    } finally {
      detectBusyRef.current = false;
    }
  }, [lookup, stopCamera]);

  /** Runs only from the button's own click — never on mount or open. */
  const startCamera = React.useCallback(async () => {
    const ctor = barcodeDetectorCtor();
    if (!ctor || !cameraAvailable()) return;

    setMessage(null);
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera();
        setPhase("idle");
        return;
      }
      video.srcObject = stream;
      await video.play();
      try {
        detectorRef.current = new ctor({ formats: BARCODE_FORMATS });
      } catch {
        // An engine that rejects the format list still detects with defaults.
        detectorRef.current = new ctor();
      }
      setPhase("scanning");
      timerRef.current = window.setInterval(() => void detectFrame(), DETECT_INTERVAL_MS);
    } catch (error) {
      stopCamera();
      const denied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      setPhase(denied ? "denied" : "failed");
    }
  }, [detectFrame, stopCamera]);

  const cameraOn = phase === "scanning" || phase === "starting";
  const manualValid = BARCODE_PATTERN.test(manual);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          stopCamera();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Scan a barcode</DialogTitle>
          <DialogDescription>
            Scanning happens entirely on this device — no image or camera frame ever leaves it.
            Only the barcode digits are sent to Open Food Facts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {scanSupported ? (
            <div className="space-y-2">
              <div className="relative overflow-hidden rounded-lg border bg-muted/40">
                {/* Mounted whether or not the camera runs, so the ref exists
                    the moment the start click needs it. */}
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className={cn("aspect-video w-full object-cover", !cameraOn && "hidden")}
                />
                {!cameraOn && (
                  <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <Camera className="h-6 w-6 text-muted-foreground" aria-hidden />
                    <p className="text-sm text-muted-foreground">
                      {phase === "denied"
                        ? "Camera access was declined. Allow it in your browser's site settings, or type the barcode below."
                        : phase === "failed"
                          ? "The camera could not be started. Type the barcode below instead."
                          : "The camera stays off until you start it, and stops when this dialog closes."}
                    </p>
                  </div>
                )}
              </div>
              {cameraOn ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={phase === "starting"}
                  onClick={() => {
                    stopCamera();
                    setPhase("idle");
                  }}
                >
                  {phase === "starting" ? <Loader2 className="animate-spin" /> : <CameraOff />}
                  {phase === "starting" ? "Starting camera…" : "Stop camera"}
                </Button>
              ) : (
                <Button type="button" className="w-full" onClick={() => void startCamera()}>
                  <Camera /> Start camera
                </Button>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              {!cameraSupported
                ? "This browser has no camera access here, so live scanning isn't available. Type the digits printed under the bars instead — the lookup is the same."
                : "This browser can't read barcodes from a camera preview (it has no built-in barcode detector). Type the digits printed under the bars instead — the lookup is the same."}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="barcode-manual">Barcode</Label>
            <div className="flex gap-2">
              <Input
                id="barcode-manual"
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 3017620422003"
                value={manual}
                onChange={(event) => setManual(event.target.value.replace(/\D/g, "").slice(0, 14))}
                onKeyDown={(event) => event.key === "Enter" && manualValid && lookup(manual)}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!manualValid || looking}
                onClick={() => lookup(manual)}
              >
                {looking ? <Loader2 className="animate-spin" /> : <Search />}
                Look up
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">8–14 digits, printed under the bars.</p>
          </div>

          {message && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
