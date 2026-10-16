// Shows the viewer's virtual coin balance and an optional daily top-up claim.
// This is NOT a payment/deposit/cash-out control — claiming the daily top-up is
// the only way coins enter the economy besides the starting bonus.

import styles from "./BalanceBadge.module.css";

interface BalanceBadgeProps {
  balance: number;
  /** When provided, renders a "Claim top-up" button (daily free coins). */
  onClaim?: () => void;
  claiming?: boolean;
  canClaim?: boolean;
}

export default function BalanceBadge({
  balance,
  onClaim,
  claiming = false,
  canClaim = true,
}: BalanceBadgeProps) {
  return (
    <span className={styles.badge} aria-label="Coin balance">
      <span className={styles.coin} aria-hidden>
        🪙
      </span>
      <span className={styles.amount}>{balance.toLocaleString()}</span>
      {onClaim ? (
        <button
          type="button"
          className={styles.claim}
          onClick={onClaim}
          disabled={claiming || !canClaim}
        >
          {claiming ? "Claiming…" : "Daily top-up"}
        </button>
      ) : null}
    </span>
  );
}
