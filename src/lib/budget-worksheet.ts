/**
 * The budget worksheet: a spreadsheet "After Raise" sheet, ported.
 *
 * Every figure the page shows is derived here, from nothing but the saved inputs.
 * Kept pure and separate so the arithmetic can be tested without a database, a
 * browser or a form — the sums are the part most likely to be subtly wrong, and
 * being subtly wrong here means confidently telling someone their take-home pay.
 *
 * ## Sign convention
 *
 * Inputs are **positive magnitudes**. The spreadsheet stores its deductions as
 * negative numbers and subtracts them, so a total is a sum of mixed signs; a
 * missing minus anywhere silently inverts the sheet, which is exactly the sort of
 * bug that survives because every number still *looks* plausible. Everything here
 * subtracts explicitly instead.
 *
 * ## The gross-up
 *
 * The sheet does not take gross pay as given. It defines:
 *
 *     total compensation = monthly bills + stock, where stock = 12% of total
 *
 * which solves to `gross = bills / (1 - rate)`. Dividing by 0.88 is what makes the
 * salary come out *above* the bills, and it is the whole reason the sheet has an
 * ASOP line at all. `deriveGross` chooses between that and a typed salary.
 *
 * ## Semi-monthly figures
 *
 * Withholdings and pre-tax deductions are stored per pay period and doubled, which
 * is how the sheet writes them (`-365.59*2`). The doubling is applied here rather
 * than in the form, so a period figure and a monthly figure can never disagree.
 */

/** Every stored field. All amounts are positive magnitudes. */
export type WorksheetInput = {
  deriveGross: boolean;
  grossSalary: number;
  asopRate: number;

  federalWithholding: number;
  federalMedEe: number;
  federalOasdiEe: number;
  stateWithholding: number;

  k401k: number;
  vision: number;
  dental: number;
  hsa: number;
  medical: number;

  rothIra: number;

  /** Pay periods in an average month: 26/12 if biweekly, 2 if semi-monthly. */
  payPeriodsPerMonth: number;
  /** Fold the 401k and Roth into the savings figure of the 50/30/20 split. */
  includeRetirementInSavings: boolean;

  rent: number;
  utilities: number;
  wifi: number;
  rentersInsurance: number;
  carPayment: number;
  carInsurance: number;
  gas: number;
  groceriesDining: number;

  studentLoans: number;
  brokerage: number;
  hysa: number;

  idealNeeds: number;
  idealSavings: number;
  idealWants: number;
};

export type WorksheetResult = {
  /**
   * Annual **cash** salary, as typed. Stock is not included in it, because you do
   * not receive it as pay.
   */
  salaryAnnual: number;
  /** ESOP stock for the year: a share of the cash salary, on top of it. */
  stockAnnual: number;
  /** Cash salary plus stock - what the job is worth before tax. */
  totalComp: number;
  /** A month of cash pay. Take-home is built from this, not from total comp. */
  salary: number;

  /** Withholdings per month. */
  taxes: number;
  /** 401k, vision, dental, HSA and medical per month. */
  preTax: number;
  /** Roth IRA per month. */
  afterTax: number;
  /** What actually lands in the bank each month. */
  takeHome: number;

  rents: { total: number };
  car: { total: number };
  food: { total: number };
  needs: { total: number };

  /**
   * The goals bucket: student loans, brokerage, HYSA.
   *
   * This is what the spreadsheet called "Total Savings", and it excludes the
   * retirement contributions on purpose - see `savings.withRetirement`.
   */
  savings: { total: number; withRetirement: number };
  wants: number;
  /**
   * Whether the 50/30/20 split is measured against take-home or against income
   * before savings. Follows `includeRetirementInSavings`, so the three shares
   * always add up to whichever base is in play.
   */
  allocationBase: number;

  /**
   * The four fixed commitments: rent, renters insurance, the car payment and
   * student loans. This is the sheet's "Monthly Bills + Utilities", and it is what
   * gross is solved from.
   */
  bills: number;
  /** Take-home less the bills, the goals, and food. */
  everythingElse: number;
  /** Take-home plus the two retirement contributions: pay before saving anything. */
  incomeBeforeSavings: number;

  /** Retirement contributions per year, which is the point of storing them per period. */
  annualPreTax: number;
  annualAfterTax: number;

  /** Actual against target, all as fractions of income-before-savings. */
  actual: { needs: number; savings: number; wants: number };
  ideal: { needs: number; savings: number; wants: number };

  /** The three ideal amounts, for the comparison table. */
  idealAmounts: { needs: number; savings: number; wants: number };

  /** Any input that cannot produce a meaningful figure. */
  warnings: string[];
};

const MONTHS_PER_YEAR = 12;

export const WORKSHEET_DEFAULTS: WorksheetInput = {
  deriveGross: true,
  grossSalary: 0,
  asopRate: 0.12,

  federalWithholding: 0,
  federalMedEe: 0,
  federalOasdiEe: 0,
  stateWithholding: 0,

  k401k: 0,
  vision: 0,
  dental: 0,
  hsa: 0,
  medical: 0,

  rothIra: 0,

  payPeriodsPerMonth: 26 / 12,
  includeRetirementInSavings: false,

  rent: 0,
  utilities: 0,
  wifi: 0,
  rentersInsurance: 0,
  carPayment: 0,
  carInsurance: 0,
  gas: 0,
  groceriesDining: 0,

  studentLoans: 0,
  brokerage: 0,
  hysa: 0,

  idealNeeds: 0.5,
  idealSavings: 0.3,
  idealWants: 0.2,
};

/** Every numeric field, for coercing form input without hand-listing them twice. */
export const WORKSHEET_NUMBER_FIELDS = [
  "grossSalary",
  "asopRate",
  "federalWithholding",
  "federalMedEe",
  "federalOasdiEe",
  "stateWithholding",
  "k401k",
  "vision",
  "dental",
  "hsa",
  "medical",
  "rothIra",
  "payPeriodsPerMonth",
  "rent",
  "utilities",
  "wifi",
  "rentersInsurance",
  "carPayment",
  "carInsurance",
  "gas",
  "groceriesDining",
  "studentLoans",
  "brokerage",
  "hysa",
  "idealNeeds",
  "idealSavings",
  "idealWants",
] as const satisfies readonly (keyof WorksheetInput)[];

/**
 * Force arbitrary input into a usable shape.
 *
 * Anything unparseable becomes zero rather than `NaN`, because a single blank
 * field in a 27-field form would otherwise blank the entire page. Non-negative,
 * for the same reason the inputs are magnitudes: a negative deduction is a sign
 * error, not a value, and letting it through inverts take-home.
 */
/**
 * The fields entered as percentages rather than fractions.
 *
 * These are stored as fractions (0.12) because that is what the arithmetic wants,
 * but entered and displayed as whole percentages (12). The conversion lives here
 * and in the form rather than in `normaliseWorksheetInput`, because the API
 * receives fractions from the client and must not divide them a second time.
 */
export const PERCENT_FIELDS = [
  "asopRate",
  "idealNeeds",
  "idealSavings",
  "idealWants",
] as const satisfies readonly (keyof WorksheetInput)[];

/** JSON boolean, or the "on"/"" an HTML checkbox produces. */
function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false" || value === "") return false;
  return fallback;
}

export function normaliseWorksheetInput(raw: unknown): WorksheetInput {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = { ...WORKSHEET_DEFAULTS };

  for (const field of WORKSHEET_NUMBER_FIELDS) {
    const value = Number(source[field]);
    out[field] = Number.isFinite(value) ? Math.max(value, 0) : WORKSHEET_DEFAULTS[field];
  }

  /*
   * Booleans are read leniently, because the two callers send different things.
   *
   * The API receives JSON booleans. The form holds its fields as *strings* so a
   * half-typed number is not coerced mid-keystroke, which means its checkboxes
   * arrive here as "on" or "". A strict `=== true` therefore read every checkbox
   * as false, and "Count the 401k and Roth IRA as savings" did nothing at all.
   *
   * Anything absent defaults to true for `deriveGross` - the historical behaviour -
   * but the second checkbox is opt-in, so absent means false.
   */
  out.deriveGross = readBoolean(source["deriveGross"], true);
  out.includeRetirementInSavings = readBoolean(
    source["includeRetirementInSavings"],
    false,
  );

  /*
   * One to twelve periods a month. Below one there are no deductions at all, which
   * would report a full salary as take-home; above twelve is nonsense and would
   * inflate them without bound.
   */
  out.payPeriodsPerMonth = clamp(out.payPeriodsPerMonth || 26 / 12, 1, 12);

  // The rates are shares of something, so they cannot exceed the whole thing.
  out.asopRate = clamp(out.asopRate, 0, 0.95);
  out.idealNeeds = clamp(out.idealNeeds, 0, 1);
  out.idealSavings = clamp(out.idealSavings, 0, 1);
  out.idealWants = clamp(out.idealWants, 0, 1);

  return out;
}

export function computeWorksheet(input: WorksheetInput): WorksheetResult {
  const warnings: string[] = [];

  const rents = sum(input.rent, input.utilities, input.wifi, input.rentersInsurance);
  const car = sum(input.carPayment, input.carInsurance, input.gas);
  const food = input.groceriesDining;
  const needs = rents + car + food;

  /*
   * The four commitments the sheet calls "Monthly Bills + Utilities". Rent and the
   * car payment are the ones that cannot be turned off, which is why they are the
   * ones gross is solved from.
   */
  const bills = sum(
    input.rent,
    input.rentersInsurance,
    input.carPayment,
    input.studentLoans,
  );

  /*
   * Withholdings, pre-tax and after-tax are stored per pay period and doubled.
   * Factored out so the solve below can ask what the monthly deductions will be
   * without computing them twice and risking the two disagreeing.
   */
  const periods = input.payPeriodsPerMonth;
  const taxes = perMonth(
    periods,
    input.federalWithholding,
    input.federalMedEe,
    input.federalOasdiEe,
    input.stateWithholding,
  );
  const preTax = perMonth(
    periods,
    input.k401k,
    input.vision,
    input.dental,
    input.hsa,
    input.medical,
  );
  const afterTax = perMonth(periods, input.rothIra);
  const deductions = taxes + preTax + afterTax;

  /*
   * Stock is a share of the cash salary, granted *on top* of it - so it is added,
   * not divided out of. (The spreadsheet's own `E8 = E4 + F8` with
   * `F8 = E8*0.12` reads as though the stock sat inside the gross, which produces a
   * salary far below the deductions taken from it. The real rule is the simpler
   * one: you are paid $88,360 and are additionally granted 12% of that, so total
   * compensation is $98,963.20.)
   *
   * Take-home is built from the **cash** salary alone. Stock is not pay that lands
   * in an account, so counting it here would inflate the figure everything else on
   * the page is measured against.
   */
  const salaryAnnual = input.deriveGross
    ? solveSalaryForBills(bills, deductions)
    : input.grossSalary;

  const stockAnnual = salaryAnnual * input.asopRate;
  const totalComp = salaryAnnual + stockAnnual;
  const salary = salaryAnnual / MONTHS_PER_YEAR;

  if (salaryAnnual === 0) {
    warnings.push(
      input.deriveGross
        ? "No salary could be solved, because there are no bills yet. Enter a rent or a car payment, or type a salary."
        : "No salary entered, so every figure below is zero.",
    );
  }

  const takeHome = salary - deductions;

  if (takeHome < 0) {
    warnings.push(
      "Your deductions are more than your monthly salary, which means take-home is negative. Check the salary and the per-pay-period figures.",
    );
  }

  const goals = sum(input.studentLoans, input.brokerage, input.hysa);
  const retirement = preTax + afterTax;

  /*
   * The goals come out of take-home; the retirement contributions come out of
   * gross before the money is yours. They are different pots, which is why wants is
   * the remainder of take-home either way and only the *comparison* moves when
   * retirement is folded in.
   */
  const wants = takeHome - needs - goals;
  const savings = {
    total: goals,
    withRetirement: goals + retirement,
  };
  const everythingElse = takeHome - bills - input.brokerage - input.hysa - food;
  const incomeBeforeSavings = takeHome + preTax + afterTax;

  /*
   * Actual and ideal are both fractions of income, but of different things, and
   * conflating them is how a worksheet ends up arguing with itself:
   *
   *  - `actual` divides take-home, because that is the pot the three actually
   *    compete for and it is what the sheet's C column shows.
   *  - `idealAmounts` divides income *before* savings, because the 50/30/20 rule
   *    is written against what you earn, not what survives the 401k.
   *
   * Wants is the remainder, so the three always sum to the whole - the split is a
   * report of what happened, not another thing to reconcile.
   */
  const savingsForSplit = input.includeRetirementInSavings
    ? savings.withRetirement
    : savings.total;
  const allocationBase = input.includeRetirementInSavings
    ? incomeBeforeSavings
    : takeHome;

  const actual = share(allocationBase, {
    needs,
    savings: savingsForSplit,
    wants,
  });
  const ideal = {
    needs: input.idealNeeds,
    savings: input.idealSavings,
    wants: input.idealWants,
  };

  return {
    salaryAnnual,
    stockAnnual,
    totalComp,
    salary,
    taxes,
    preTax,
    afterTax,
    takeHome,
    rents: { total: rents },
    car: { total: car },
    food: { total: food },
    needs: { total: needs },
    savings,
    wants,
    allocationBase,
    bills,
    everythingElse,
    incomeBeforeSavings,
    annualPreTax: preTax * MONTHS_PER_YEAR,
    annualAfterTax: afterTax * MONTHS_PER_YEAR,
    actual,
    ideal,
    idealAmounts: {
      needs: incomeBeforeSavings * ideal.needs,
      savings: incomeBeforeSavings * ideal.savings,
      wants: incomeBeforeSavings * ideal.wants,
    },
    warnings,
  };
}

/**
 * The cash salary at which take-home exactly covers the bills.
 *
 * `monthlySalary - deductions = bills`, so this answers the question the
 * spreadsheet was reaching for with its bills-to-salary relationship: what do I
 * have to earn for this plan to work?
 *
 * The stock is deliberately not in the arithmetic. It is granted on top of the
 * salary and never arrives as cash, so including it would let a plan appear to
 * balance on money that cannot pay a rent.
 */
export function solveSalaryForBills(bills: number, monthlyDeductions: number): number {
  if (!Number.isFinite(bills) || !Number.isFinite(monthlyDeductions)) return 0;
  if (bills <= 0) return 0;
  return Math.max(bills + Math.max(monthlyDeductions, 0), 0) * MONTHS_PER_YEAR;
}

/**
 * Per-pay-period figures to a monthly figure.
 *
 * The multiplier is the user's, not a constant: biweekly pay repeats 26 times a
 * year and semi-monthly pay 24, and using 2 for both understates a year of
 * withholding by two whole paychecks.
 */
function perMonth(periods: number, ...values: number[]): number {
  return sum(...values) * periods;
}

/**
 * Fractions of a pot, for the percentage columns.
 *
 * Negative parts are floored at zero rather than passed through: a month where
 * spending outruns income has a *negative* wants figure, and a "-12%" in a
 * percentage column reads as a bug. The signed amount is reported separately and
 * is where the overspend actually shows.
 */
function share(base: number, parts: { needs: number; savings: number; wants: number }) {
  const clamped = {
    needs: Math.max(parts.needs, 0),
    savings: Math.max(parts.savings, 0),
    wants: Math.max(parts.wants, 0),
  };
  const total = sum(clamped.needs, clamped.savings, clamped.wants);
  if (total === 0) return { needs: 0, savings: 0, wants: 0 };
  return {
    needs: clamped.needs / total,
    savings: clamped.savings / total,
    wants: clamped.wants / total,
  };
}

function sum(...values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}