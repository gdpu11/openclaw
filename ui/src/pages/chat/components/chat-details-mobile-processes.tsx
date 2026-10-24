import { For, Show } from "solid-js";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerProcessesEnglish } from "../../../i18n/locales/en-processes.ts";
import { registerSessionOrganizationEnglish } from "../../../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatDetailsProcessRow } from "./chat-details-process-row.tsx";
import type { createProcessesPresentation } from "./chat-processes-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

registerEnglishCatalog(registerProcessesEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);

export type ChatDetailsMobileProcessesProps = {
  /** The session host retains the native ProcessesPanelData projection and its demand. */
  data: Pick<ProcessesPanelData["snapshot"], "rows" | "error" | "errorKind" | "loading"> &
    Pick<ProcessesPanelData, "refresh"> & {
      presentation: ReturnType<typeof createProcessesPresentation>;
    };
  presented: boolean;
  onOpen?: (instanceId?: string) => void;
};

/** Two native process rows; the existing host opens the complete collection. */
export function ChatDetailsMobileProcesses(props: ChatDetailsMobileProcessesProps) {
  return (
    <div class="chat-details-mobile-processes">
      <Show when={props.data.errorKind !== "read" && props.data.error}>
        <div class="chat-details-mobile-processes__error" role="alert">
          <span>{props.data.error}</span>
          <button
            type="button"
            class="chip"
            disabled={!props.presented || props.data.loading}
            onClick={() => void props.data.refresh()}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <div role="list" aria-label={t("chat.sessionDetails.processes")}>
        <For each={props.data.rows.slice(0, 2)} keyed={(row) => row.instanceId}>
          {(row) => (
            <ChatDetailsProcessRow
              presentation={props.data.presentation}
              row={row()}
              disabled={!props.presented}
              onOpen={props.onOpen}
            />
          )}
        </For>
      </div>
      <Show when={props.onOpen}>
        <button
          type="button"
          class="chat-details-mobile-root__entry chat-details-mobile-processes__show-all"
          disabled={!props.presented}
          onClick={() => props.onOpen?.()}
        >
          <span class="chat-details-mobile-root__copy">{t("chat.processesPanel.viewAll")}</span>
        </button>
      </Show>
    </div>
  );
}
