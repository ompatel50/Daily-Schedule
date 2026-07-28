import type { FoodCategory } from "@/lib/enums";

/**
 * Bundled food database.
 *
 * Deliberate product decision: the app ships its own food table rather than
 * calling a third-party nutrition API. A remote API would mean every meal you
 * log leaks to someone else's server, needs a key, and stops working offline —
 * all of which conflict with "private, local-first". This covers everyday
 * whole foods and common staples; anything missing can be added as a custom
 * food in a few seconds, and custom foods are first-class in search.
 *
 * Values are per 100 g unless `basis` is `per_serving`, and are rounded
 * reference values (USDA-style) — good enough for daily tracking, not a
 * clinical dataset.
 */
export interface SeedFood {
  name: string;
  brand?: string;
  basis?: "per_100g" | "per_serving";
  servingSize: number;
  servingUnit: string;
  servingLabel?: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  category: FoodCategory;
}

export const SEED_FOODS: SeedFood[] = [
  // --- protein --------------------------------------------------------------
  { name: "Chicken breast, grilled", servingSize: 140, servingUnit: "g", servingLabel: "1 breast (140 g)", calories: 165, protein: 31, carbs: 0, fat: 3.6, sodium: 74, category: "protein" },
  { name: "Chicken thigh, roasted", servingSize: 110, servingUnit: "g", calories: 209, protein: 26, carbs: 0, fat: 10.9, sodium: 84, category: "protein" },
  { name: "Ground beef, 90% lean", servingSize: 113, servingUnit: "g", calories: 176, protein: 20, carbs: 0, fat: 10, sodium: 66, category: "protein" },
  { name: "Ground turkey, 93% lean", servingSize: 112, servingUnit: "g", calories: 170, protein: 22, carbs: 0, fat: 9, sodium: 70, category: "protein" },
  { name: "Sirloin steak", servingSize: 170, servingUnit: "g", calories: 206, protein: 30, carbs: 0, fat: 9, sodium: 55, category: "protein" },
  { name: "Salmon, baked", servingSize: 140, servingUnit: "g", servingLabel: "1 fillet (140 g)", calories: 208, protein: 20, carbs: 0, fat: 13, sodium: 59, category: "protein" },
  { name: "Tuna, canned in water", servingSize: 142, servingUnit: "g", servingLabel: "1 can (142 g)", calories: 116, protein: 26, carbs: 0, fat: 0.8, sodium: 247, category: "protein" },
  { name: "Shrimp, cooked", servingSize: 85, servingUnit: "g", calories: 99, protein: 24, carbs: 0.2, fat: 0.3, sodium: 111, category: "protein" },
  { name: "Cod, baked", servingSize: 140, servingUnit: "g", calories: 105, protein: 23, carbs: 0, fat: 0.9, sodium: 78, category: "protein" },
  { name: "Egg, large", basis: "per_serving", servingSize: 50, servingUnit: "g", servingLabel: "1 large egg", calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8, sodium: 71, category: "protein" },
  { name: "Egg white", basis: "per_serving", servingSize: 33, servingUnit: "g", servingLabel: "1 white", calories: 17, protein: 3.6, carbs: 0.2, fat: 0.1, sodium: 55, category: "protein" },
  { name: "Tofu, firm", servingSize: 122, servingUnit: "g", calories: 144, protein: 17, carbs: 3, fat: 9, fiber: 2, sodium: 14, category: "protein" },
  { name: "Tempeh", servingSize: 100, servingUnit: "g", calories: 192, protein: 20, carbs: 8, fat: 11, fiber: 5, sodium: 9, category: "protein" },
  { name: "Black beans, cooked", servingSize: 172, servingUnit: "g", servingLabel: "1 cup (172 g)", calories: 132, protein: 8.9, carbs: 24, fat: 0.5, fiber: 8.7, sodium: 2, category: "protein" },
  { name: "Chickpeas, cooked", servingSize: 164, servingUnit: "g", servingLabel: "1 cup (164 g)", calories: 164, protein: 8.9, carbs: 27, fat: 2.6, fiber: 7.6, sodium: 7, category: "protein" },
  { name: "Lentils, cooked", servingSize: 198, servingUnit: "g", servingLabel: "1 cup (198 g)", calories: 116, protein: 9, carbs: 20, fat: 0.4, fiber: 7.9, sodium: 2, category: "protein" },
  { name: "Whey protein powder", basis: "per_serving", servingSize: 31, servingUnit: "g", servingLabel: "1 scoop (31 g)", calories: 120, protein: 24, carbs: 3, fat: 1.5, sodium: 130, category: "supplement" },
  { name: "Plant protein powder", basis: "per_serving", servingSize: 33, servingUnit: "g", servingLabel: "1 scoop (33 g)", calories: 130, protein: 21, carbs: 6, fat: 2.5, fiber: 3, sodium: 250, category: "supplement" },

  // --- dairy ----------------------------------------------------------------
  { name: "Greek yogurt, plain nonfat", servingSize: 170, servingUnit: "g", servingLabel: "1 container (170 g)", calories: 59, protein: 10, carbs: 3.6, fat: 0.4, sugar: 3.2, sodium: 36, category: "dairy" },
  { name: "Greek yogurt, whole milk", servingSize: 170, servingUnit: "g", calories: 97, protein: 9, carbs: 4, fat: 5, sugar: 4, sodium: 35, category: "dairy" },
  { name: "Cottage cheese, 2%", servingSize: 113, servingUnit: "g", calories: 84, protein: 11, carbs: 4.3, fat: 2.3, sugar: 4.1, sodium: 330, category: "dairy" },
  { name: "Milk, 2%", servingSize: 244, servingUnit: "ml", servingLabel: "1 cup (244 ml)", calories: 50, protein: 3.3, carbs: 4.8, fat: 2, sugar: 5, sodium: 44, category: "dairy" },
  { name: "Whole milk", servingSize: 244, servingUnit: "ml", calories: 61, protein: 3.2, carbs: 4.8, fat: 3.3, sugar: 5.1, sodium: 43, category: "dairy" },
  { name: "Almond milk, unsweetened", servingSize: 240, servingUnit: "ml", calories: 15, protein: 0.6, carbs: 0.6, fat: 1.2, sodium: 72, category: "dairy" },
  { name: "Cheddar cheese", servingSize: 28, servingUnit: "g", servingLabel: "1 oz (28 g)", calories: 403, protein: 25, carbs: 1.3, fat: 33, sodium: 621, category: "dairy" },
  { name: "Mozzarella, part skim", servingSize: 28, servingUnit: "g", calories: 254, protein: 24, carbs: 2.8, fat: 16, sodium: 619, category: "dairy" },
  { name: "Parmesan, grated", servingSize: 5, servingUnit: "g", servingLabel: "1 tbsp (5 g)", calories: 420, protein: 38, carbs: 4, fat: 28, sodium: 1600, category: "dairy" },
  { name: "Butter", servingSize: 14, servingUnit: "g", servingLabel: "1 tbsp (14 g)", calories: 717, protein: 0.9, carbs: 0.1, fat: 81, sodium: 11, category: "fat" },

  // --- grains ---------------------------------------------------------------
  { name: "White rice, cooked", servingSize: 158, servingUnit: "g", servingLabel: "1 cup (158 g)", calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4, sodium: 1, category: "grain" },
  { name: "Brown rice, cooked", servingSize: 195, servingUnit: "g", servingLabel: "1 cup (195 g)", calories: 112, protein: 2.6, carbs: 24, fat: 0.9, fiber: 1.8, sodium: 5, category: "grain" },
  { name: "Quinoa, cooked", servingSize: 185, servingUnit: "g", servingLabel: "1 cup (185 g)", calories: 120, protein: 4.4, carbs: 21, fat: 1.9, fiber: 2.8, sodium: 7, category: "grain" },
  { name: "Oats, dry rolled", servingSize: 40, servingUnit: "g", servingLabel: "1/2 cup (40 g)", calories: 389, protein: 17, carbs: 66, fat: 6.9, fiber: 11, sodium: 2, category: "grain" },
  { name: "Pasta, cooked", servingSize: 140, servingUnit: "g", servingLabel: "1 cup (140 g)", calories: 158, protein: 5.8, carbs: 31, fat: 0.9, fiber: 1.8, sodium: 1, category: "grain" },
  { name: "Whole wheat bread", basis: "per_serving", servingSize: 43, servingUnit: "g", servingLabel: "1 slice (43 g)", calories: 110, protein: 4, carbs: 20, fat: 1.5, fiber: 3, sodium: 180, category: "grain" },
  { name: "Sourdough bread", basis: "per_serving", servingSize: 50, servingUnit: "g", servingLabel: "1 slice (50 g)", calories: 130, protein: 4.5, carbs: 25, fat: 0.8, fiber: 1.2, sodium: 290, category: "grain" },
  { name: "Bagel, plain", basis: "per_serving", servingSize: 98, servingUnit: "g", servingLabel: "1 bagel", calories: 270, protein: 11, carbs: 53, fat: 1.5, fiber: 2, sodium: 430, category: "grain" },
  { name: "Tortilla, flour", basis: "per_serving", servingSize: 45, servingUnit: "g", servingLabel: "1 tortilla", calories: 140, protein: 4, carbs: 24, fat: 3.5, fiber: 1, sodium: 350, category: "grain" },
  { name: "Sweet potato, baked", servingSize: 150, servingUnit: "g", servingLabel: "1 medium (150 g)", calories: 90, protein: 2, carbs: 21, fat: 0.1, fiber: 3.3, sugar: 6.5, sodium: 36, category: "vegetable" },
  { name: "Potato, baked", servingSize: 173, servingUnit: "g", servingLabel: "1 medium (173 g)", calories: 93, protein: 2.5, carbs: 21, fat: 0.1, fiber: 2.2, sodium: 10, category: "vegetable" },

  // --- vegetables -----------------------------------------------------------
  { name: "Broccoli, steamed", servingSize: 156, servingUnit: "g", servingLabel: "1 cup (156 g)", calories: 35, protein: 2.4, carbs: 7.2, fat: 0.4, fiber: 3.3, sodium: 41, category: "vegetable" },
  { name: "Spinach, raw", servingSize: 30, servingUnit: "g", servingLabel: "1 cup (30 g)", calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2, sodium: 79, category: "vegetable" },
  { name: "Kale, raw", servingSize: 21, servingUnit: "g", calories: 49, protein: 4.3, carbs: 8.8, fat: 0.9, fiber: 3.6, sodium: 38, category: "vegetable" },
  { name: "Bell pepper, red", servingSize: 119, servingUnit: "g", servingLabel: "1 medium (119 g)", calories: 31, protein: 1, carbs: 6, fat: 0.3, fiber: 2.1, sugar: 4.2, sodium: 4, category: "vegetable" },
  { name: "Carrots, raw", servingSize: 128, servingUnit: "g", servingLabel: "1 cup (128 g)", calories: 41, protein: 0.9, carbs: 9.6, fat: 0.2, fiber: 2.8, sugar: 4.7, sodium: 69, category: "vegetable" },
  { name: "Cucumber", servingSize: 104, servingUnit: "g", calories: 15, protein: 0.7, carbs: 3.6, fat: 0.1, fiber: 0.5, sodium: 2, category: "vegetable" },
  { name: "Tomato", servingSize: 123, servingUnit: "g", servingLabel: "1 medium (123 g)", calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, fiber: 1.2, sugar: 2.6, sodium: 5, category: "vegetable" },
  { name: "Mixed salad greens", servingSize: 85, servingUnit: "g", calories: 17, protein: 1.4, carbs: 3.3, fat: 0.2, fiber: 1.8, sodium: 28, category: "vegetable" },
  { name: "Asparagus, roasted", servingSize: 134, servingUnit: "g", calories: 22, protein: 2.4, carbs: 4.1, fat: 0.2, fiber: 2.1, sodium: 2, category: "vegetable" },
  { name: "Brussels sprouts, roasted", servingSize: 156, servingUnit: "g", calories: 43, protein: 3.4, carbs: 9, fat: 0.3, fiber: 3.8, sodium: 25, category: "vegetable" },
  { name: "Zucchini", servingSize: 124, servingUnit: "g", calories: 17, protein: 1.2, carbs: 3.1, fat: 0.3, fiber: 1, sodium: 8, category: "vegetable" },
  { name: "Onion", servingSize: 110, servingUnit: "g", calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1, fiber: 1.7, sugar: 4.2, sodium: 4, category: "vegetable" },
  { name: "Mushrooms, sautéed", servingSize: 96, servingUnit: "g", calories: 28, protein: 2.2, carbs: 5.3, fat: 0.5, fiber: 2.2, sodium: 2, category: "vegetable" },
  { name: "Green beans, steamed", servingSize: 125, servingUnit: "g", calories: 35, protein: 1.9, carbs: 7.9, fat: 0.1, fiber: 3.4, sodium: 6, category: "vegetable" },

  // --- fruit ----------------------------------------------------------------
  { name: "Banana", basis: "per_serving", servingSize: 118, servingUnit: "g", servingLabel: "1 medium (118 g)", calories: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1, sugar: 14, sodium: 1, category: "fruit" },
  { name: "Apple", basis: "per_serving", servingSize: 182, servingUnit: "g", servingLabel: "1 medium (182 g)", calories: 95, protein: 0.5, carbs: 25, fat: 0.3, fiber: 4.4, sugar: 19, sodium: 2, category: "fruit" },
  { name: "Blueberries", servingSize: 148, servingUnit: "g", servingLabel: "1 cup (148 g)", calories: 57, protein: 0.7, carbs: 14, fat: 0.3, fiber: 2.4, sugar: 10, sodium: 1, category: "fruit" },
  { name: "Strawberries", servingSize: 152, servingUnit: "g", servingLabel: "1 cup (152 g)", calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, fiber: 2, sugar: 4.9, sodium: 1, category: "fruit" },
  { name: "Orange", basis: "per_serving", servingSize: 131, servingUnit: "g", servingLabel: "1 medium", calories: 62, protein: 1.2, carbs: 15, fat: 0.2, fiber: 3.1, sugar: 12, sodium: 0, category: "fruit" },
  { name: "Grapes", servingSize: 151, servingUnit: "g", servingLabel: "1 cup (151 g)", calories: 69, protein: 0.7, carbs: 18, fat: 0.2, fiber: 0.9, sugar: 16, sodium: 2, category: "fruit" },
  { name: "Avocado", basis: "per_serving", servingSize: 100, servingUnit: "g", servingLabel: "1/2 avocado (100 g)", calories: 160, protein: 2, carbs: 8.5, fat: 15, fiber: 6.7, sugar: 0.7, sodium: 7, category: "fat" },
  { name: "Mango", servingSize: 165, servingUnit: "g", calories: 60, protein: 0.8, carbs: 15, fat: 0.4, fiber: 1.6, sugar: 14, sodium: 1, category: "fruit" },
  { name: "Pineapple", servingSize: 165, servingUnit: "g", calories: 50, protein: 0.5, carbs: 13, fat: 0.1, fiber: 1.4, sugar: 10, sodium: 1, category: "fruit" },
  { name: "Watermelon", servingSize: 152, servingUnit: "g", calories: 30, protein: 0.6, carbs: 7.6, fat: 0.2, fiber: 0.4, sugar: 6.2, sodium: 1, category: "fruit" },

  // --- fats & nuts ----------------------------------------------------------
  { name: "Olive oil", servingSize: 14, servingUnit: "g", servingLabel: "1 tbsp (14 g)", calories: 884, protein: 0, carbs: 0, fat: 100, sodium: 2, category: "fat" },
  { name: "Peanut butter", servingSize: 32, servingUnit: "g", servingLabel: "2 tbsp (32 g)", calories: 588, protein: 25, carbs: 20, fat: 50, fiber: 6, sugar: 9, sodium: 429, category: "fat" },
  { name: "Almond butter", servingSize: 32, servingUnit: "g", calories: 614, protein: 21, carbs: 19, fat: 56, fiber: 10, sugar: 4, sodium: 7, category: "fat" },
  { name: "Almonds", servingSize: 28, servingUnit: "g", servingLabel: "1 oz (28 g)", calories: 579, protein: 21, carbs: 22, fat: 50, fiber: 12, sugar: 4.4, sodium: 1, category: "fat" },
  { name: "Walnuts", servingSize: 28, servingUnit: "g", calories: 654, protein: 15, carbs: 14, fat: 65, fiber: 6.7, sodium: 2, category: "fat" },
  { name: "Cashews", servingSize: 28, servingUnit: "g", calories: 553, protein: 18, carbs: 30, fat: 44, fiber: 3.3, sugar: 5.9, sodium: 12, category: "fat" },
  { name: "Chia seeds", servingSize: 28, servingUnit: "g", calories: 486, protein: 17, carbs: 42, fat: 31, fiber: 34, sodium: 16, category: "fat" },
  { name: "Ground flaxseed", servingSize: 10, servingUnit: "g", calories: 534, protein: 18, carbs: 29, fat: 42, fiber: 27, sodium: 30, category: "fat" },

  // --- prepared -------------------------------------------------------------
  { name: "Chicken burrito bowl", basis: "per_serving", servingSize: 1, servingUnit: "bowl", servingLabel: "1 bowl", calories: 640, protein: 45, carbs: 65, fat: 20, fiber: 9, sodium: 1450, category: "prepared" },
  { name: "Turkey sandwich", basis: "per_serving", servingSize: 1, servingUnit: "sandwich", calories: 420, protein: 28, carbs: 45, fat: 13, fiber: 4, sodium: 1100, category: "prepared" },
  { name: "Caesar salad with chicken", basis: "per_serving", servingSize: 1, servingUnit: "salad", calories: 470, protein: 34, carbs: 14, fat: 31, fiber: 3, sodium: 980, category: "prepared" },
  { name: "Cheese pizza slice", basis: "per_serving", servingSize: 107, servingUnit: "g", servingLabel: "1 slice", calories: 285, protein: 12, carbs: 36, fat: 10, fiber: 2.5, sodium: 640, category: "prepared" },
  { name: "Sushi roll, salmon avocado", basis: "per_serving", servingSize: 1, servingUnit: "roll", calories: 304, protein: 13, carbs: 42, fat: 9, fiber: 4, sodium: 490, category: "prepared" },
  { name: "Protein bar", basis: "per_serving", servingSize: 60, servingUnit: "g", servingLabel: "1 bar", calories: 210, protein: 20, carbs: 22, fat: 7, fiber: 8, sugar: 3, sodium: 200, category: "snack" },
  { name: "Oatmeal with berries", basis: "per_serving", servingSize: 1, servingUnit: "bowl", calories: 310, protein: 10, carbs: 54, fat: 6, fiber: 8, sugar: 12, sodium: 120, category: "prepared" },
  { name: "Scrambled eggs and toast", basis: "per_serving", servingSize: 1, servingUnit: "plate", calories: 380, protein: 21, carbs: 30, fat: 19, fiber: 3, sodium: 620, category: "prepared" },

  // --- snacks ---------------------------------------------------------------
  { name: "Dark chocolate, 70%", servingSize: 28, servingUnit: "g", calories: 598, protein: 7.8, carbs: 46, fat: 43, fiber: 11, sugar: 24, sodium: 20, category: "snack" },
  { name: "Popcorn, air-popped", servingSize: 8, servingUnit: "g", servingLabel: "1 cup (8 g)", calories: 387, protein: 13, carbs: 78, fat: 4.5, fiber: 15, sodium: 8, category: "snack" },
  { name: "Tortilla chips", servingSize: 28, servingUnit: "g", calories: 489, protein: 7, carbs: 65, fat: 23, fiber: 5, sodium: 400, category: "snack" },
  { name: "Hummus", servingSize: 30, servingUnit: "g", servingLabel: "2 tbsp (30 g)", calories: 166, protein: 7.9, carbs: 14, fat: 9.6, fiber: 6, sodium: 379, category: "snack" },
  { name: "Rice cake", basis: "per_serving", servingSize: 9, servingUnit: "g", servingLabel: "1 cake", calories: 35, protein: 0.7, carbs: 7.3, fat: 0.3, fiber: 0.4, sodium: 29, category: "snack" },
  { name: "Trail mix", servingSize: 40, servingUnit: "g", calories: 462, protein: 14, carbs: 45, fat: 29, fiber: 5, sugar: 25, sodium: 210, category: "snack" },

  // --- beverages ------------------------------------------------------------
  { name: "Coffee, black", servingSize: 240, servingUnit: "ml", servingLabel: "1 cup (240 ml)", calories: 1, protein: 0.1, carbs: 0, fat: 0, sodium: 2, category: "beverage" },
  { name: "Latte, whole milk", basis: "per_serving", servingSize: 350, servingUnit: "ml", servingLabel: "1 grande", calories: 190, protein: 12, carbs: 18, fat: 7, sugar: 17, sodium: 150, category: "beverage" },
  { name: "Green tea", servingSize: 240, servingUnit: "ml", calories: 1, protein: 0, carbs: 0, fat: 0, sodium: 1, category: "beverage" },
  { name: "Orange juice", servingSize: 248, servingUnit: "ml", calories: 45, protein: 0.7, carbs: 10, fat: 0.2, sugar: 8.4, sodium: 1, category: "beverage" },
  { name: "Sports drink", servingSize: 355, servingUnit: "ml", calories: 25, protein: 0, carbs: 6, fat: 0, sugar: 6, sodium: 41, category: "beverage" },
  { name: "Beer, regular", basis: "per_serving", servingSize: 355, servingUnit: "ml", servingLabel: "1 can", calories: 153, protein: 1.6, carbs: 13, fat: 0, sodium: 14, category: "beverage" },
  { name: "Red wine", basis: "per_serving", servingSize: 148, servingUnit: "ml", servingLabel: "1 glass", calories: 125, protein: 0.1, carbs: 3.8, fat: 0, sugar: 0.9, sodium: 6, category: "beverage" },
];
