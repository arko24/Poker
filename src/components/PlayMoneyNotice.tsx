// Persistent, always-visible notice that the coins are play money with no
// real-world value and that this is not gambling (FR-3). This component is
// mounted at the top of the shell on every screen and has no dismiss control.

import styles from "./PlayMoneyNotice.module.css";

export default function PlayMoneyNotice() {
  return (
    <div className={styles.notice} role="note" aria-label="Play money notice">
      <span className={styles.strong}>Play money only.</span> Coins have no
      real-world value and cannot be bought, sold, deposited, or cashed out.
      This is a game for fun, not gambling.
    </div>
  );
}
