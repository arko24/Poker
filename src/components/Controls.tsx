// Controls: fold / check / call / bet / raise with an amount control bounded by
// the snapshot's legalActions. Rendered ONLY on the viewer's own turn (the
// parent passes legalActions only then). Amounts are clamped to the legal
// [min, max]; the server re-validates authoritatively.
//
// Bet/raise min/max are "to" levels per design.md. When min===max===stack the
// only legal bet is an all-in, so the control collapses to a single all-in
// button (short-stack all-in bet, Finding 8).

"use client";

import { useMemo, useState } from "react";
import type { LegalAction } from "@/types";
import styles from "./Controls.module.css";

export type ActionKind = "fold" | "check" | "call" | "bet" | "raise" | "allin";

interface ControlsProps {
  legalActions: LegalAction[];
  disabled?: boolean;
  /** Submit an action; amount is the "to" level for bet/raise, omitted otherwise. */
  onAction: (action: ActionKind, amount?: number) => void;
}

function find<T extends LegalAction["type"]>(
  actions: LegalAction[],
  type: T,
): Extract<LegalAction, { type: T }> | undefined {
  return actions.find((a) => a.type === type) as
    | Extract<LegalAction, { type: T }>
    | undefined;
}

export default function Controls({
  legalActions,
  disabled = false,
  onAction,
}: ControlsProps) {
  const fold = find(legalActions, "fold");
  const check = find(legalActions, "check");
  const call = find(legalActions, "call");
  const bet = find(legalActions, "bet");
  const raise = find(legalActions, "raise");
  const allin = find(legalActions, "allin");

  // The bet/raise amount control uses whichever of bet/raise is present.
  const amountAction = bet ?? raise;
  const amountKind: ActionKind | null = bet ? "bet" : raise ? "raise" : null;

  const [amount, setAmount] = useState<number>(amountAction?.min ?? 0);

  // Keep amount within the current bounds whenever legalActions change.
  const bounds = useMemo(() => {
    if (!amountAction) return null;
    return { min: amountAction.min, max: amountAction.max };
  }, [amountAction]);

  const clamped = bounds
    ? Math.max(bounds.min, Math.min(bounds.max, amount || bounds.min))
    : 0;

  // Collapse bet/raise to a single all-in control when min===max (only one
  // legal "to" level, i.e. an all-in for the whole stack).
  const collapseToAllin = Boolean(bounds && bounds.min === bounds.max);

  return (
    <div className={styles.controls}>
      <div className={styles.buttons}>
        {fold ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.fold}`}
            disabled={disabled}
            onClick={() => onAction("fold")}
          >
            Fold
          </button>
        ) : null}

        {check ? (
          <button
            type="button"
            className={styles.btn}
            disabled={disabled}
            onClick={() => onAction("check")}
          >
            Check
          </button>
        ) : null}

        {call ? (
          <button
            type="button"
            className={styles.btn}
            disabled={disabled}
            onClick={() => onAction("call")}
          >
            Call {call.amount.toLocaleString()}
          </button>
        ) : null}

        {amountAction && amountKind && !collapseToAllin ? (
          <button
            type="button"
            className={styles.btn}
            disabled={disabled}
            onClick={() => onAction(amountKind, clamped)}
          >
            {amountKind === "bet" ? "Bet" : "Raise to"} {clamped.toLocaleString()}
          </button>
        ) : null}

        {allin ? (
          <button
            type="button"
            className={styles.btn}
            disabled={disabled}
            onClick={() => onAction("allin")}
          >
            All-in {allin.amount.toLocaleString()}
          </button>
        ) : collapseToAllin && amountKind && amountAction ? (
          <button
            type="button"
            className={styles.btn}
            disabled={disabled}
            onClick={() => onAction(amountKind, amountAction.max)}
          >
            All-in {amountAction.max.toLocaleString()}
          </button>
        ) : null}
      </div>

      {amountAction && !collapseToAllin ? (
        <div className={styles.amount}>
          <span className={styles.label}>
            {amountKind === "bet" ? "Bet to" : "Raise to"} (
            {amountAction.min.toLocaleString()}–{amountAction.max.toLocaleString()})
          </span>
          <div className={styles.amountRow}>
            <input
              type="range"
              min={amountAction.min}
              max={amountAction.max}
              step={1}
              value={clamped}
              disabled={disabled}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            <input
              type="number"
              min={amountAction.min}
              max={amountAction.max}
              value={clamped}
              disabled={disabled}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
