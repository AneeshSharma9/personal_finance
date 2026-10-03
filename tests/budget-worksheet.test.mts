import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The schema module directly, not `@/db`: that one opens a connection at import
 * time and would need a DATABASE_URL to run a test that should need nothing.
 */
import * as tables from "@/db/schema";
import {
  computeWorksheet,
  normaliseWorksheetInput,
  solveSalaryForBills,
  WORKSHEET_DEFAULTS,
  PERCENT_FIELDS,
  WORKSHEET_NUMBER_FIELDS,
  type WorksheetInput,
} from "@/lib/budget-worksheet";

/**
 * The worksheet arithmetic.
 *
 * Two things are being defended here. The first is the transcription: the inputs
 * below are the "After Raise" sheet's own figures, so a formula that quietly
 * differs from the spreadsheet shows up as a failing number rather than as a
 * subtly wrong take-home pay. The second is the identities — take-home plus every
 * deduction has to be salary, and needs plus savings plus wants has to be
 * take-home — because those hold regardless of what the numbers happen to be, and
 * they catch an error that a single worked example would not.
 */

const near = (actual: number, expected: number, message: string, tolerance = 0.01) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} != ${expected}`,
  );

/**
 * The sheet's own line items, per pay period and monthly as it records them.
 *
 * The salary is *typed* rather than solved, which is the finding these tests
 * encode: solving it off the bills gives a monthly salary of $238 against
 * $2,611 of deductions, so take-home comes out thousands negative. Typed at
 * $85,860 the same worksheet produces a take-home within a few dollars of what
 * the bank actually recorded, and that agreement is what says which half of the
 * sheet is the load-bearing one.
 */
const SHEET: WorksheetInput = {
  ...WORKSHEET_DEFAULTS,
  deriveGross: false,
  grossSalary: 88360,
  asopRate: 0.12,
  payPeriodsPerMonth: 26 / 12,

  federalWithholding: 365.59,
  federalMedEe: 47.96,
  federalOasdiEe: 205.06,
  stateWithholding: 221.52,

  k401k: 101.95,
  vision: 6.06,
  dental: 17.52,
  hsa: 22.47,
  medical: 45.71,

  rothIra: 271.88,

  rent: 1447,
  utilities: 150,
  wifi: 30,
  rentersInsurance: 12,
  carPayment: 453.91,
  carInsurance: 0,
  gas: 75,
  groceriesDining: 400,

  studentLoans: 600,
  brokerage: 200,
  hysa: 200,
};

test("the sheet's own line items transcribe to its own totals", () => {
  const r = computeWorksheet(SHEET);

  // Rent 1447 + 150 + 30 + 12.
  near(r.rents.total, 1639, "total rents");
  // Car 453.91 + 0 + 75.
  near(r.car.total, 528.91, "total car");
  near(r.food.total, 400, "total food");
  near(r.needs.total, 2567.91, "total core needs");

  near(r.savings.total, 1000, "total savings");

  // Rent + renters insurance + car payment + student loans.
  near(r.bills, 2512.91, "monthly bills");

  // Per pay period, times 26/12 rather than a flat 2.
  near(r.taxes, 840.13 * (26 / 12), "withholdings per month");
  near(r.preTax, 193.71 * (26 / 12), "pre-tax per month");
  near(r.afterTax, 271.88 * (26 / 12), "roth per month");
});

test("stock is a share of the salary granted on top of it", () => {
  const r = computeWorksheet(SHEET);

  // $88,360 cash, plus 12% of that, plus nothing else.
  near(r.salaryAnnual, 88360, "annual cash salary as typed");
  near(r.stockAnnual, 10603.2, "12% of the salary, added to it");
  near(r.totalComp, 98963.2, "total compensation");
  near(r.salary, 88360 / 12, "monthly cash pay");

  /*
   * The mistake this guards: treating the stock as already inside the salary and
   * dividing by (1 - rate) instead of multiplying by (1 + rate). That reports
   * $78,893 of cash and calls it $88,360 of gross, so the page understates pay by
   * nearly $10k a year - and every other figure, being a share of it, is wrong too.
   */
  near(r.totalComp, r.salaryAnnual * 1.12, "salary times one plus the stock rate");
});

test("take-home is built from the cash salary, never from stock", () => {
  const r = computeWorksheet(SHEET);

  // 840.13 x 26/12, not x 2.
  near(r.taxes, 840.13 * (26 / 12), "withholdings per month");
  near(r.preTax, 193.71 * (26 / 12), "pre-tax per month");
  near(r.afterTax, 271.88 * (26 / 12), "roth per month");
  near(
    r.takeHome,
    r.salary - r.taxes - r.preTax - r.afterTax,
    "take-home identity",
  );
  near(r.incomeBeforeSavings, r.takeHome + r.preTax + r.afterTax, "income before savings");

  /*
   * Stock is never cash, so it must not inflate the figure everything else is
   * measured against. A raise that is entirely stock leaves take-home untouched,
   * and this is what says so.
   */
  assert.ok(r.takeHome < r.salary, "take-home is cash salary less deductions only");
  const noStock = computeWorksheet({ ...SHEET, asopRate: 0 });
  assert.equal(noStock.takeHome, r.takeHome, "stock does not change take-home");
});

test("the salary solve asks what you must earn for the bills to work", () => {
  // Take-home exactly covers the four fixed bills.
  const solved = computeWorksheet({ ...SHEET, deriveGross: true });

  // The salary has to carry the bills *and* the deductions taken from it.
  const deductions = solved.taxes + solved.preTax + solved.afterTax;
  near(solved.salary, solved.bills + deductions, "monthly salary is bills plus deductions", 0.01);
  near(solved.takeHome, solved.bills, "so take-home covers the bills exactly", 0.01);
  // And stock is still reported on top of the solved figure.
  near(solved.stockAnnual, solved.salaryAnnual * 0.12, "stock still granted");
});

test("a salary solve with no bills is not a salary", () => {
  const none = computeWorksheet({ ...WORKSHEET_DEFAULTS, deriveGross: true });
  assert.equal(none.salaryAnnual, 0);
  assert.match(none.warnings.join(" "), /no bills|bills/i);
});

test("retirement figures are annual, which is why periods are stored", () => {
  const r = computeWorksheet(SHEET);
  near(r.annualPreTax, r.preTax * 12, "pre-tax per year");
  near(r.annualAfterTax, r.afterTax * 12, "roth per year");
});

test("typing a salary skips the solve", () => {
  const typed = computeWorksheet({ ...SHEET, grossSalary: 120000 });
  near(typed.salaryAnnual, 120000, "salary as typed");
  near(typed.salary, 10000, "a twelfth of it per month");
  near(typed.stockAnnual, 14400, "stock on top");
  near(typed.totalComp, 134400, "total compensation");
  assert.equal(typed.warnings.length, 0, "and it needs no explanation");

  // Both paths exist, and the solve is a genuinely different answer.
  const solved = computeWorksheet({ ...SHEET, deriveGross: true });
  assert.notEqual(solved.salaryAnnual, typed.salaryAnnual);
});

test("the salary solve cannot invent one", () => {
  assert.equal(solveSalaryForBills(0, 500), 0, "no bills means no salary to solve for");
  assert.equal(solveSalaryForBills(2000, 500), 30000, "bills plus deductions, times twelve");
  assert.equal(solveSalaryForBills(2000, -500), 24000, "a negative deduction cannot shrink a salary");
  assert.equal(solveSalaryForBills(Number.NaN, 500), 0, "junk in, zero out");
});

test("an empty worksheet explains itself instead of showing silent zeros", () => {
  const r = computeWorksheet({ ...WORKSHEET_DEFAULTS });
  assert.equal(r.takeHome, 0);
  assert.equal(r.actual.needs, 0, "no divide-by-zero in the percentages");
  assert.match(r.warnings.join(" "), /bills/i, "and it says why");
});

test("deductions exceeding salary is called out, because take-home cannot be negative", () => {
  const r = computeWorksheet({ ...SHEET, grossSalary: 12000 });
  assert.ok(r.takeHome < 0);
  assert.match(r.warnings.join(" "), /negative/i);
});

test("normalising survives junk without blanking the page", () => {
  const n = normaliseWorksheetInput({
    rent: "1447",
    wifi: "",
    gas: null,
    hysa: -200,
    asopRate: 3,
    idealNeeds: 0.5,
    deriveGross: false,
  });
  assert.equal(n.rent, 1447, "numeric strings are accepted");
  assert.equal(n.wifi, 0, "a blank is zero");
  assert.equal(n.gas, 0, "null is zero");
  assert.equal(n.hysa, 0, "a negative amount is not a magnitude");
  assert.equal(n.asopRate, 0.95, "a rate cannot exceed 95%");
  assert.equal(n.deriveGross, false, "the checkbox is explicit");

  // Absurd input must not produce NaN anywhere in the result.
  const r = computeWorksheet(normaliseWorksheetInput({ rent: "abc", gas: {} }));
  assert.ok(Number.isFinite(r.takeHome));
  assert.ok(Number.isFinite(r.actual.needs));
});

test("every numeric field survives a round trip through normalisation", () => {
  const n = normaliseWorksheetInput({});
  for (const [key, value] of Object.entries(n)) {
    if (key === "deriveGross" || key === "includeRetirementInSavings") continue;
    assert.equal(typeof value, "number", `${key} must be a number`);
    assert.ok(Number.isFinite(value as number), `${key} must be finite`);
  }
  assert.equal(typeof n.deriveGross, "boolean");
  assert.equal(typeof n.includeRetirementInSavings, "boolean");
});
/**
 * The field list has to agree with the table.
 *
 * This is here because of a bug, not for tidiness. `saveBudgetWorksheet` builds
 * its insert object by mapping the field list over the row it was given, and it
 * briefly used SQL column names (`gross_salary`) instead of Drizzle field names
 * (`grossSalary`). Drizzle does not reject unknown keys - it ignores them - so
 * every camelCase field silently saved as zero while the four whose names happen
 * to be identical in both (`k401k`, `rent`, `gas`, `hysa`) worked. Half the form
 * saved and looked fine.
 *
 * Asserting the field list is real columns catches that before a row is ever
 * written, and costs nothing because it needs no database.
 */
test("every worksheet field is a real field on the table", () => {
  for (const field of WORKSHEET_NUMBER_FIELDS) {
    assert.ok(
      field in tables.budgetWorksheet,
      `${field} is not a field on budget_worksheet, so it would be dropped on save`,
    );
  }
  assert.ok("deriveGross" in tables.budgetWorksheet, "and the checkbox is persisted");
});

test("the field list covers every numeric input exactly once", () => {
  const BOOLEANS = new Set(["deriveGross", "includeRetirementInSavings"]);
  const declared = new Set(WORKSHEET_NUMBER_FIELDS);
  for (const key of Object.keys(WORKSHEET_DEFAULTS)) {
    if (BOOLEANS.has(key)) continue;
    assert.ok(declared.has(key as never), `${key} is missing from the field list`);
  }
  assert.equal(
    declared.size,
    Object.keys(WORKSHEET_DEFAULTS).length - BOOLEANS.size,
    "and the list has nothing in it that is not a numeric input",
  );
  assert.ok("includeRetirementInSavings" in tables.budgetWorksheet, "and the second checkbox is persisted");
});

/**
 * How many times a pay period repeats in a month.
 *
 * The spreadsheet multiplied every per-paycheck figure by 2. That is right for
 * semi-monthly pay and wrong for biweekly, which is the more common arrangement in
 * the US: 26 checks a year is 2.1667 a month, so a flat 2 models two paychecks that
 * never arrive and overstates take-home by a year's worth of the difference.
 */
test("biweekly pay is not two pay periods a month", () => {
  const biweekly = computeWorksheet({ ...SHEET, payPeriodsPerMonth: 26 / 12 });
  const semiMonthly = computeWorksheet({ ...SHEET, payPeriodsPerMonth: 2 });

  near(
    biweekly.takeHome + biweekly.taxes + biweekly.preTax + biweekly.afterTax,
    88360 / 12,
    "biweekly: cash salary is shared out correctly",
  );
  assert.ok(
    biweekly.taxes > semiMonthly.taxes,
    "biweekly withholds more a month than semi-monthly, because there are more checks",
  );

  // The tie that settles it, against what the app has actually recorded as income.
  near(biweekly.takeHome, 4510.44, "biweekly lands on recorded income", 40);
  assert.ok(
    Math.abs(semiMonthly.takeHome - 4510.44) > 200,
    "while a flat 2 is hundreds out",
  );
});

test("an annual view is what the pay period count is really for", () => {
  // Twice the periods means twice the withholding, which is what 26 checks instead
  // of 24 actually does to a year.
  const biweekly = computeWorksheet({ ...SHEET, payPeriodsPerMonth: 26 / 12 });
  const semiMonthly = computeWorksheet({ ...SHEET, payPeriodsPerMonth: 2 });

  near(biweekly.taxes * 12, 840.13 * 26, "biweekly withholds 26 checks a year");
  near(semiMonthly.taxes * 12, 840.13 * 24, "semi-monthly withholds 24");
});

test("retirement is a separate pot from the goals, and can be folded in", () => {
  const separate = computeWorksheet({ ...SHEET, includeRetirementInSavings: false });
  const folded = computeWorksheet({ ...SHEET, includeRetirementInSavings: true });

  // The goals bucket is the spreadsheet's "Total Savings", and excludes retirement.
  near(separate.savings.total, 1000, "goals only");
  near(separate.savings.withRetirement, 1000 + separate.preTax + separate.afterTax, "goals plus retirement");
  // Compared with a tolerance, because a stored pay-period count is a decimal
  // approximation of 26/12: at numeric(6,4) the 0.00003 error is worth about four
  // cents a month, which is real but not a behaviour difference.
  near(separate.wants, folded.wants, "wants is unaffected by the choice", 0.05);

  // Off: the split is of take-home, because retirement already left before then.
  near(separate.allocationBase, separate.takeHome, "base is take-home");
  near(separate.actual.needs + separate.actual.savings + separate.actual.wants, 1, "and it still adds up");

  // On: the split is of income before savings, and the larger savings share reflects it.
  near(folded.allocationBase, folded.incomeBeforeSavings, "base is income before savings");
  near(folded.actual.needs + folded.actual.savings + folded.actual.wants, 1, "and that adds up too");
  assert.ok(folded.actual.savings > separate.actual.savings, "counting retirement raises the savings share");
});

test("the pay period count is bounded, so it cannot invent money", () => {
  const absurd = normaliseWorksheetInput({ payPeriodsPerMonth: 500 });
  assert.ok(absurd.payPeriodsPerMonth <= 12);
  const none = normaliseWorksheetInput({ payPeriodsPerMonth: 0 });
  assert.ok(none.payPeriodsPerMonth >= 1, "and never zero, which would pay the full salary out");
});

/**
 * Checkboxes, which failed silently.
 *
 * The form holds its fields as strings so a half-typed number is not coerced
 * mid-keystroke, which means its checkboxes reach `normaliseWorksheetInput` as
 * "on" or "". A strict `=== true` read every one of them as false, so "Count the
 * 401k and Roth IRA as savings" could be ticked and nothing happened - no warning,
 * no error, and the numbers stayed put.
 */
test("a checkbox sent as an HTML form value is still read as true", () => {
  assert.equal(normaliseWorksheetInput({ includeRetirementInSavings: "on" }).includeRetirementInSavings, true);
  assert.equal(normaliseWorksheetInput({ includeRetirementInSavings: "" }).includeRetirementInSavings, false);
  // And a real JSON boolean, which is what the API receives.
  assert.equal(normaliseWorksheetInput({ includeRetirementInSavings: true }).includeRetirementInSavings, true);
  // Absent is opt-in, so false.
  assert.equal(normaliseWorksheetInput({}).includeRetirementInSavings, false);
});

test("deriveGross reads leniently too, but stays opt-out", () => {
  assert.equal(normaliseWorksheetInput({ deriveGross: "" }).deriveGross, false, "an unticked box is off");
  assert.equal(normaliseWorksheetInput({ deriveGross: "on" }).deriveGross, true);
  assert.equal(normaliseWorksheetInput({}).deriveGross, true, "absent keeps the historical default");
});

test("the checkbox actually changes the figures", () => {
  // The real path: normalise the string the form sends, then compute.
  const ticked = computeWorksheet(
    normaliseWorksheetInput({ ...SHEET, includeRetirementInSavings: "on" }),
  );
  const unticked = computeWorksheet(
    normaliseWorksheetInput({ ...SHEET, includeRetirementInSavings: "" }),
  );

  assert.notEqual(ticked.allocationBase, unticked.allocationBase, "the base moves");
  assert.ok(ticked.actual.savings > unticked.actual.savings, "and so does the savings share");
  assert.equal(ticked.wants, unticked.wants, "while wants is untouched");
  assert.equal(ticked.savings.total, unticked.savings.total, "and the goals bucket is unaffected");
});

/**
 * Percent fields are stored as fractions and entered as whole percentages.
 *
 * Entering "12" for a 12% stock rate is the natural thing to do; asking someone to
 * type 0.12 for a percentage is not. The conversion is done in the form, because
 * `normaliseWorksheetInput` also receives fractions from the API and must not
 * divide them a second time.
 */
test("percentage fields are declared for the form to convert", () => {
  assert.deepEqual(
    [...PERCENT_FIELDS].sort(),
    ["asopRate", "idealNeeds", "idealSavings", "idealWants"].sort(),
  );
  for (const field of PERCENT_FIELDS) {
    assert.ok(field in tables.budgetWorksheet, `${field} is still a real column`);
    assert.ok(
      (WORKSHEET_NUMBER_FIELDS as readonly string[]).includes(field),
      `${field} is still stored`,
    );
  }
});

test("a percent stays a fraction once converted", () => {
  // What the form sends after dividing the typed "12" by 100.
  const n = normaliseWorksheetInput({ asopRate: 12 / 100, idealNeeds: 50 / 100 });
  assert.equal(n.asopRate, 0.12);
  assert.equal(n.idealNeeds, 0.5);

  // A percent typed past 100% cannot become a nonsense fraction.
  assert.equal(normaliseWorksheetInput({ asopRate: 200 / 100 }).asopRate, 0.95);
  assert.equal(normaliseWorksheetInput({ idealNeeds: 150 / 100 }).idealNeeds, 1);
  assert.equal(normaliseWorksheetInput({ idealWants: -5 / 100 }).idealWants, 0);
});

/**
 * The ideal amounts, and the base they divide.
 *
 * This is a bug a user found rather than one a test would have: with the
 * retirement checkbox off, the caption said the split was measured against
 * take-home while the Amount column divided income *before* savings. So 50% of
 * needs printed as $2,771.50 against a stated base of $4,534.23, where $2,267.12
 * was the figure the caption implied - both on screen at once, and nothing to say
 * which was wrong.
 */
test("the ideal amounts divide the base the caption names", () => {
  const off = computeWorksheet(SHEET);
  near(off.allocationBase, off.takeHome, "unchecked: the base is take-home");
  near(off.idealAmounts.needs, off.takeHome * 0.5, "unchecked: 50% of take-home");
  near(off.idealAmounts.savings, off.takeHome * 0.3, "unchecked: 30% of take-home");
  near(off.idealAmounts.wants, off.takeHome * 0.2, "unchecked: 20% of take-home");

  const on = computeWorksheet({ ...SHEET, includeRetirementInSavings: true });
  near(
    on.allocationBase,
    on.incomeBeforeSavings,
    "checked: the base is income before savings",
  );
  near(
    on.idealAmounts.needs,
    on.incomeBeforeSavings * 0.5,
    "checked: 50% of income before savings",
  );
  assert.notEqual(
    on.idealAmounts.needs,
    off.idealAmounts.needs,
    "so the two states genuinely differ",
  );
});

test("the three targets are the whole base, in both states", () => {
  for (const includeRetirementInSavings of [false, true]) {
    const r = computeWorksheet({ ...SHEET, includeRetirementInSavings });
    const total =
      r.idealAmounts.needs + r.idealAmounts.savings + r.idealAmounts.wants;
    near(total, r.allocationBase, `targets add up (retirement ${includeRetirementInSavings})`);
  }
});

test("the actual column and the amount column share one base", () => {
  /*
   * Both columns have to be measured against the same number. When they were not, a
   * row could show a percentage of take-home beside an amount derived from
   * something larger, and both looked entirely reasonable on their own.
   */
  const r = computeWorksheet(SHEET);
  near(r.actual.needs, r.needs.total / r.takeHome, "actual needs is a share of take-home");
  near(r.actual.needs * r.allocationBase, r.needs.total, "and of the allocation base");

  // And the same holds with retirement folded in.
  const on = computeWorksheet({ ...SHEET, includeRetirementInSavings: true });
  near(
    on.actual.needs * on.allocationBase,
    on.needs.total,
    "still one base when retirement counts as savings",
  );
});

/**
 * The two "Wants" figures, which are meant to differ.
 *
 * A user read them as a contradiction: the Wants total said $968.32 while the
 * ideal-allocation table said $906.85 for the same row. Neither was wrong - the
 * total is what actually remained, the table is the 20% guideline - but the table
 * column was headed just "Amount", which reads like the real figure. So the two
 * displays are tied together here instead: the table's Actual share has to be the
 * same number as the total, and it only matches because the real allocation was
 * 21%, not 20%.
 */
test("the table's actual wants is the wants total, in percentages", () => {
  const r = computeWorksheet(SHEET);

  // The total is the outcome.
  near(r.wants, r.takeHome - r.needs.total - r.savings.total, "wants is the remainder");

  // The table's share is that same outcome over the allocation base.
  const share = r.takeHome > 0 ? r.wants / r.allocationBase : 0;
  near(r.actual.wants, share, "the Actual column is the total, as a share");
});

test("the guideline and the outcome are different quantities", () => {
  const r = computeWorksheet(SHEET);

  near(r.idealAmounts.wants, r.allocationBase * 0.2, "the table's wants is the 20% target");

  /*
   * They coincide only when the real allocation happens to be 20%. Asserted
   * positively so a future "fix" that quietly made one derive from the other would
   * be visible here rather than on the page.
   */
  const matches = Math.abs(r.idealAmounts.wants - r.wants) < 0.005;
  assert.equal(
    matches,
    Math.abs(r.actual.wants - r.ideal.wants) < 0.005,
    "the two agree exactly when the actual share hits the target",
  );
});
