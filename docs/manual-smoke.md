# Interactive manual smoke

This visual check is **pending**; automated fixtures and the headless provider smoke do not establish that it passed. Use a safe non-production workspace and the existing, configured Pi/Atelier/nicobailon-pi-subagents setup. This extension must be loaded only once; see the [local trial](../README.md#requirements-and-local-trial). Do not change other extensions or their configuration to simulate failures.

1. Start Pi with Atelier, the provider and this extension. Open `/atelier display` and enable **Subagents**. Check that one panel appears and other panels are unchanged.
2. Using your existing subagent workflow, request two independent, harmless **read-only** jobs in parallel, such as summarizing different documentation files. Do not assume a particular provider invocation syntax. While they run, check active ordering and available task, role, model, duration and token fields. Let them finish and check the displayed outcomes; exercise foreground execution too if your workflow supports it.
3. Automated fixtures cover completed and failed records. Do not present a fixture or a stopped/cancelled job as a failed live run. If an independently available, safe job actually fails, check that failure sorts ahead of successes; otherwise record live failure as **not verified**. Stopped/cancelled states should remain neutral, not successful.
4. Run `/subagents-bar hide`, `show`, `toggle`, and the bare `/subagents-bar` command. Check summary-only versus expanded content; Atelier panel enablement should not change.
5. Resize the terminal and narrow the sidebar. Check clipping and layout without expecting interactive rows. Run `/reload`; check for one panel and no duplicates. Switch sessions, then return if desired, and check that no old-session data leaks into the new view and available history rebuilds.
6. If installed, verify the profile cycler and subscription panel still behave normally in your own environment. Do not expose credentials or alter their configuration. The headless test only checks factory/command coexistence; it skips subscription lifecycle and does not verify live operation.

Record versions, observations and any unverified cases. Do not fabricate a failure or infer a successful visual check from automated results.
