"use client";

import { useId, useMemo, useState } from "react";

import {
  computeWorksheet,
  normaliseWorksheetInput,
  PERCENT_FIELDS,
  WORKSHEET_DEFAULTS,
  type WorksheetInput,
} from "@/lib/budget-worksheet";
import { formatCurrency } from "@/lib/format";
import { selectAllProps } from "@/lib/select-all";

/**
 * The budget worksheet, calculating live exactly as the spreadsheet did.
 *
 * A live calculation rather than a calculate button, because the point of the
 * sheet was that you could change one number and watch the split move. Every
 * figure below the inputs comes from `computeWorksheet`, the same function the API
 * uses to produce what it saves - so what you see before saving and what the server
 * stores cannot disagree.
 *
 * Inputs are kept as **text** while being typed, not as numbers. Coercing on every
 * keystroke is what makes a numeric input eat the trailing "." of "12." and refuse
 * to let the field clear; normalisation happens on the way into the maths instead.
 */

type Fields = Record<string, string>;

const BOOLEAN_FIELDS = ["deriveGross", "includeRetirementInSavings"] as const;
const PERCENTS = new Set<string>(PERCENT_FIELDS);

function toFields(input: WorksheetInput): Fields {
  const fields: Fields = {};
  for (const [key, value] of Object.entries(input)) {
    if (BOOLEAN_FIELDS.includes(key as never)) {
      // "on" is what an HTML checkbox produces, so this round-trips.
      fields[key] = value ? "on" : "";
    } else if (PERCENTS.has(key)) {
      // Shown as the whole percentage the user thinks in - 12, not 0.12.
      fields[key] = percentToText(value as number);
    } else {
      fields[key] = String(value);
    }
  }
  return fields;
}

/** 0.12 -> "12". Trimmed, so 0.125 reads as "12.5" rather than "12.500000000000004". */
function percentToText(fraction: number): string {
  const scaled = fraction * 100;
  return Number(scaled.toFixed(4)).toString();
}

export function BudgetWorksheetForm({ saved }: { saved: WorksheetInput }) {
  const [fields, setFields] = useState<Fields>(() =>
    toFields(saved ?? WORKSHEET_DEFAULTS),
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  /*
   * Fields are strings, so the percent columns need converting here rather than in
   * `normaliseWorksheetInput` - which also receives fractions from the API and must
   * not divide them again. Both checkboxes are sent as real booleans for the same
   * reason.
   */
  const input = useMemo(() => {
    const raw: Record<string, unknown> = {
      ...fields,
      deriveGross: fields["deriveGross"] === "on",
      includeRetirementInSavings: fields["includeRetirementInSavings"] === "on",
    };
    for (const field of PERCENT_FIELDS) {
      raw[field] = Number(fields[field] ?? 0) / 100;
    }
    return normaliseWorksheetInput(raw);
  }, [fields]);
  const r = useMemo(() => computeWorksheet(input), [input]);

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setStatus("idle");
    setFields((current) => ({ ...current, [key]: event.target.value }));
  };

  const save = async () => {
    setStatus("saving");
    try {
      const response = await fetch("/api/worksheet", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Save failed (${response.status}).`);
      }
      setStatus("saved");
      setMessage("");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Save failed.");
    }
  };

  return (
    <div className="space-y-8">
      <Section title="Income">
        <Checkbox
          label="Solve the salary my bills need instead of typing it"
          checked={fields["deriveGross"] === "on"}
          onChange={(event) => {
            setStatus("idle");
            setFields((c) => ({ ...c, deriveGross: event.target.checked ? "on" : "" }));
          }}
        />
        <Line
          label="Annual salary"
          value={fields["grossSalary"] ?? ""}
          onChange={set("grossSalary")}
          disabled={input.deriveGross}
          hint={
            input.deriveGross
              ? `Solved: ${formatCurrency(r.salaryAnnual)} a year`
              : undefined
          }
        />
        <Line
          label="Stock as a share of salary"
          value={fields["asopRate"] ?? ""}
          onChange={set("asopRate")}
          suffix="%"
          hint={`Granted on top, so ${formatCurrency(r.stockAnnual)} a year`}
        />
        <Total
          label="Monthly salary"
          value={r.salary}
          sub="Cash pay, before stock"
        />
        <Total
          label="Total compensation"
          value={r.totalComp}
          sub={`${formatCurrency(r.stockAnnual)} of it stock`}
        />
      </Section>

      <Section
        title="Withholdings"
        note="Per pay period, multiplied to a month."
      >
        <Line
          label="Pay periods per month"
          value={fields["payPeriodsPerMonth"] ?? ""}
          onChange={set("payPeriodsPerMonth")}
          hint={
            input.payPeriodsPerMonth > 2.05 && input.payPeriodsPerMonth < 2.3
              ? "Biweekly: 26 checks a year"
              : input.payPeriodsPerMonth > 1.95
                ? "Semi-monthly: 24 a year"
                : undefined
          }
        />
        <p className="text-xs text-neutral-500">
          Everything below is entered per pay period and multiplied by this. If you
          are paid twice a month on the 1st and 15th, use 2. If you are paid every
          other Friday, use 2.1667 — the spreadsheet&apos;s 2 models only 24
          paychecks a year and understates a year of withholding by two.
        </p>
        <Line label="Federal withholding" value={fields["federalWithholding"] ?? ""} onChange={set("federalWithholding")} />
        <Line label="Federal Medicare" value={fields["federalMedEe"] ?? ""} onChange={set("federalMedEe")} />
        <Line label="Federal OASDI" value={fields["federalOasdiEe"] ?? ""} onChange={set("federalOasdiEe")} />
        <Line label="State withholding" value={fields["stateWithholding"] ?? ""} onChange={set("stateWithholding")} />
        <Total label="Withheld per month" value={r.taxes} negative />
      </Section>

      <Section title="Pre-tax deductions" note="Per pay period, multiplied to a month.">
        <Line label="401k" value={fields["k401k"] ?? ""} onChange={set("k401k")} />
        <Line label="Vision" value={fields["vision"] ?? ""} onChange={set("vision")} />
        <Line label="Dental" value={fields["dental"] ?? ""} onChange={set("dental")} />
        <Line label="HSA" value={fields["hsa"] ?? ""} onChange={set("hsa")} />
        <Line label="Medical" value={fields["medical"] ?? ""} onChange={set("medical")} />
        <Total
          label="Pre-tax per month"
          value={r.preTax}
          sub={`${formatCurrency(r.annualPreTax)} a year`}
          negative
        />
      </Section>

      <Section title="After-tax deductions" note="Per pay period, multiplied to a month.">
        <Line label="Roth IRA" value={fields["rothIra"] ?? ""} onChange={set("rothIra")} />
        <Total
          label="After-tax per month"
          value={r.afterTax}
          sub={`${formatCurrency(r.annualAfterTax)} a year`}
          negative
        />
      </Section>

      <Total
        label="Monthly take-home"
        value={r.takeHome}
        big
        tone={r.takeHome < 0 ? "bad" : "good"}
      />

      <Section title="Needs" note="Monthly.">
        <Line label="Rent" value={fields["rent"] ?? ""} onChange={set("rent")} />
        <Line label="Utilities" value={fields["utilities"] ?? ""} onChange={set("utilities")} />
        <Line label="Wi-Fi" value={fields["wifi"] ?? ""} onChange={set("wifi")} />
        <Line label="Renters insurance" value={fields["rentersInsurance"] ?? ""} onChange={set("rentersInsurance")} />
        <Total label="Total rent and utilities" value={r.rents.total} sub={`${pct(r.actual.needs)} of take-home`} />

        <Line label="Car payment" value={fields["carPayment"] ?? ""} onChange={set("carPayment")} />
        <Line label="Car insurance" value={fields["carInsurance"] ?? ""} onChange={set("carInsurance")} />
        <Line label="Gas" value={fields["gas"] ?? ""} onChange={set("gas")} />
        <Total label="Total car" value={r.car.total} />

        <Line label="Groceries and dining" value={fields["groceriesDining"] ?? ""} onChange={set("groceriesDining")} />
        <Total label="Total needs" value={r.needs.total} sub={`${pct(r.actual.needs)} of take-home`} />

        {/*
          Labelled as what it is rather than what it is used for. This line used to
          read "Monthly bills used to solve your gross", which described a
          calculation that is only running when the solve checkbox is ticked - so
          with a typed salary it introduced a number and explained it with a
          mechanism that was switched off.

          It is worth keeping either way: these four are the commitments that recur
          regardless of the month, so they are the floor the rest of the budget has
          to fit inside. Note it is not the same set as Total needs above, which
          also includes utilities, wifi, car insurance and gas.
        */}
        <div className="rounded bg-neutral-50 p-3 text-sm dark:bg-neutral-800/60">
          <p className="text-neutral-500">
            Fixed monthly commitments:{" "}
            <span className="tabular-nums text-neutral-900 dark:text-neutral-100">
              {formatCurrency(r.bills)}
            </span>{" "}
            — rent, renters insurance, car payment and student loans.
          </p>
          {input.deriveGross ? (
            <p className="mt-1 text-xs text-neutral-500">
              Your salary is being solved from this figure, so it has to cover your
              deductions as well: {formatCurrency(r.salaryAnnual)} a year.
            </p>
          ) : null}
        </div>
      </Section>

      <Section title="Financial goals" note="Monthly.">
        <Line label="Student loans" value={fields["studentLoans"] ?? ""} onChange={set("studentLoans")} />
        <Line label="Brokerage" value={fields["brokerage"] ?? ""} onChange={set("brokerage")} />
        <Line label="HYSA" value={fields["hysa"] ?? ""} onChange={set("hysa")} />
        <Total
          label="Total savings (goals)"
          value={r.savings.total}
          sub="Student loans, brokerage, HYSA"
        />
        <Total
          label="With retirement"
          value={r.savings.withRetirement}
          sub={`Adds ${formatCurrency(r.preTax + r.afterTax)} of 401k and Roth`}
        />
      </Section>

      {/*
        The actual outcome, and marked as such: the ideal-allocation table below
        also has a "Wants" figure, which is the 20% target rather than this. They
        are meant to differ, and a reader should not have to work out which is
        which.
      */}
      <Total
        label="Wants"
        value={r.wants}
        big
        sub="Actual — what was left after needs and goals"
        tone={r.wants < 0 ? "bad" : "neutral"}
      />

      <Section title="Ideal allocation">
        {/*
          Beside the table rather than down in Financial goals: it changes nothing
          except this comparison. An earlier version put it down there, which is far
          enough below the fold to read as missing.
        */}
        <Checkbox
          label="Count the 401k and Roth IRA as savings"
          checked={fields["includeRetirementInSavings"] === "on"}
          onChange={(event) => {
            setStatus("idle");
            setFields((c) => ({
              ...c,
              includeRetirementInSavings: event.target.checked ? "on" : "",
            }));
          }}
        />
        <p className="text-xs text-neutral-500">
          {input.includeRetirementInSavings
            ? `Counting them puts ${formatCurrency(r.savings.withRetirement)} into savings instead of ${formatCurrency(r.savings.total)}.`
            : `Left out, so savings is the goals alone: ${formatCurrency(r.savings.total)}.`}
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th scope="col" className="py-1 font-normal">Share</th>
              <th scope="col" className="py-1 text-right font-normal">Target</th>
              <th scope="col" className="py-1 text-right font-normal">Actual</th>
              {/*
                "Target amount", not "Amount". These are two different quantities
                and the short header made them look like a contradiction: this
                column is the 50/30/20 guideline, while the Wants total further up
                the page is what actually remained. For most people those differ -
                21% actual against a 20% target is the whole point of the table.
              */}
              <th scope="col" className="py-1 text-right font-normal">
                Target amount
              </th>
            </tr>
          </thead>
          <tbody>
            <Allocation
              label="Needs"
              field="idealNeeds"
              fields={fields}
              set={set("idealNeeds")}
              target={r.ideal.needs}
              actual={r.actual.needs}
              amount={r.idealAmounts.needs}
            />
            <Allocation
              label="Savings"
              field="idealSavings"
              fields={fields}
              set={set("idealSavings")}
              target={r.ideal.savings}
              actual={r.actual.savings}
              amount={r.idealAmounts.savings}
            />
            <Allocation
              label="Wants"
              field="idealWants"
              fields={fields}
              set={set("idealWants")}
              target={r.ideal.wants}
              actual={r.actual.wants}
              amount={r.idealAmounts.wants}
            />
          </tbody>
        </table>
        <p className="text-xs text-neutral-500">
          Measured against {formatCurrency(r.allocationBase)} —{" "}
          {input.includeRetirementInSavings
            ? "take-home plus the two retirement contributions, since those count as savings above."
            : "take-home, with the retirement contributions left out."}
        </p>
      </Section>

      {r.warnings.length > 0 ? (
        <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {r.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={save}
          disabled={status === "saving"}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {status === "saving" ? "Saving…" : "Save worksheet"}
        </button>
        {status === "saved" ? (
          <span className="text-sm text-green-700 dark:text-green-400">Saved.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-sm text-red-700 dark:text-red-400">{message}</span>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 border-b border-neutral-200 pb-1 dark:border-neutral-800">
        <h2 className="text-sm font-medium">{title}</h2>
        {note ? <span className="text-xs text-neutral-500">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Line({
  label,
  value,
  onChange,
  suffix,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  suffix?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <div className="flex items-center gap-3 text-sm">
      <label htmlFor={id} className="flex-1 text-neutral-600 dark:text-neutral-300">
        {label}
      </label>
      {hint ? (
        <span className="hidden text-xs text-neutral-400 sm:block">{hint}</span>
      ) : null}
      <div className="relative w-32">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...selectAllProps}
          className={`w-full rounded border border-neutral-200 py-1 text-right tabular-nums disabled:opacity-50 dark:border-neutral-700 dark:bg-transparent ${
            /*
             * Right padding is reserved for the suffix while the figure stays
             * right-aligned. Letting the number run under the sign is what put a
             * "%" through the digits on the stock rate.
             */
            suffix ? "pr-6 pl-2" : "px-2"
          }`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function Total({
  label,
  value,
  sub,
  big,
  negative,
  tone = "neutral",
}: {
  label: string;
  value: number;
  sub?: string;
  big?: boolean;
  negative?: boolean;
  tone?: "neutral" | "good" | "bad";
}) {
  const colour =
    tone === "good"
      ? "text-green-700 dark:text-green-400"
      : tone === "bad"
        ? "text-red-700 dark:text-red-400"
        : "";

  return (
    <div
      className={`flex items-baseline justify-between gap-3 rounded bg-neutral-50 px-3 py-2 dark:bg-neutral-800/60 ${
        big ? "text-base font-medium" : "text-sm"
      }`}
    >
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <span className="flex items-baseline gap-2">
        {sub ? (
          <span className="text-xs text-neutral-500">{sub}</span>
        ) : null}
        <span className={`tabular-nums ${colour}`}>
          {negative && value > 0 ? "−" : ""}
          {formatCurrency(value)}
        </span>
      </span>
    </div>
  );
}

function Allocation({
  label,
  field,
  fields,
  set,
  target,
  actual,
  amount,
}: {
  label: string;
  field: string;
  fields: Fields;
  set: (event: React.ChangeEvent<HTMLInputElement>) => void;
  target: number;
  actual: number;
  amount: number;
}) {
  const over = actual > target + 0.005;
  return (
    <tr className="border-b border-neutral-100 dark:border-neutral-800/60">
      <th scope="row" className="py-1.5 text-left font-normal">
        {label}
      </th>
      <td className="py-1.5 text-right">
        <div className="relative ml-auto w-20">
          <input
            type="text"
            inputMode="decimal"
            value={fields[field] ?? ""}
            onChange={set}
            {...selectAllProps}
            className="w-full rounded border border-neutral-200 py-0.5 pl-1.5 pr-5 text-right tabular-nums dark:border-neutral-700 dark:bg-transparent"
          />
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400">
            %
          </span>
        </div>
      </td>
      <td
        className={`tabular-nums py-1.5 text-right ${
          over ? "text-amber-700 dark:text-amber-400" : "text-neutral-600 dark:text-neutral-300"
        }`}
      >
        {pct(actual)}
      </td>
      <td className="tabular-nums py-1.5 text-right text-neutral-500">
        {formatCurrency(amount)}
      </td>
    </tr>
  );
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction === 0) return "—";
  return `${Math.round(fraction * 100)}%`;
}