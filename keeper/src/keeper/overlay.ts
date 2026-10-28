import type { Chain } from "./chain.js";
import type { Sender } from "./sender.js";
/** State polling is independent of socket health, including silent account-notification loss. */
export class Overlay {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly chain: Chain,
    readonly sender: Sender,
  ) {}
  start() {
    this.chain.start("keeper");
    this.timer = setInterval(() => {
      if (!this.chain.ws.ready)
        void this.sender.pollDisconnected().catch(() => {});
    }, 1000);
  }
  close() {
    clearInterval(this.timer);
    this.chain.close();
  }
}
