// Mini App shell page. PlayMoneyNotice is ALWAYS mounted at the top (persistent,
// never dismissable). PlayShell is the client state machine that authenticates
// and routes between the lobby and an active table. There is NO
// payment/deposit/withdrawal/cash-out UI anywhere in this app.

import PlayMoneyNotice from "@/components/PlayMoneyNotice";
import PlayShell from "@/components/PlayShell";

export default function HomePage() {
  return (
    <main>
      <PlayMoneyNotice />
      <PlayShell />
    </main>
  );
}
