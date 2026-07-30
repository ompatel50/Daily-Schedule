"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  dismissChecklist,
  parseOnboardingState,
  restoreChecklist,
  serializeOnboardingState,
  toggleStep,
} from "@/lib/logic/onboarding";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import {
  loadSampleData,
  previewDemoRemoval,
  removeDemoData,
  type DemoRemovalPreview,
} from "@/server/demo";

function revalidateAll() {
  revalidatePath("/", "layout");
}

// --- sample data ------------------------------------------------------------

export async function loadSampleDataAction(): Promise<ActionResult<{ records: number }>> {
  const user = await getCurrentUser();
  const result = await loadSampleData(user.id);
  if (!result.ok) return fail(result.error);
  revalidateAll();
  return succeed({ records: result.records });
}

export async function previewDemoRemovalAction(): Promise<ActionResult<DemoRemovalPreview>> {
  const user = await getCurrentUser();
  const preview = await previewDemoRemoval(user.id);
  if (!preview) return fail("No sample data is loaded.");
  return succeed(preview);
}

export async function removeDemoDataAction(): Promise<ActionResult<{ removed: number }>> {
  const user = await getCurrentUser();
  const result = await removeDemoData(user.id);
  if (!result.ok) return fail(result.error);
  revalidateAll();
  return succeed({ removed: result.removed });
}

// --- onboarding checklist ---------------------------------------------------

export async function setOnboardingStepAction(input: {
  stepId: string;
  done: boolean;
}): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const state = toggleStep(
    parseOnboardingState(user.onboardingState),
    String(input?.stepId ?? ""),
    input?.done === true,
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingState: serializeOnboardingState(state) },
  });
  revalidateAll();
  return succeed(null);
}

export async function setOnboardingVisibilityAction(visible: boolean): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const current = parseOnboardingState(user.onboardingState);
  const state = visible ? restoreChecklist(current) : dismissChecklist(current);
  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingState: serializeOnboardingState(state) },
  });
  revalidateAll();
  return succeed(null);
}
