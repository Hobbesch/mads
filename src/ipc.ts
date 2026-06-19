/**
 * IPC-Wrapper Frontend <-> Rust-Core.
 *  - HostMessages werden als JSON-String via `sidecar_send` auf den Sidecar-stdin geschrieben.
 *  - SidecarMessages kommen als NDJSON-Zeilen über einen `Channel<SidecarChannelEvent>`.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type { HostMessage, SidecarChannelEvent } from "../shared/protocol";

export function envelope() {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now() };
}

export async function startSidecar(onEvent: (e: SidecarChannelEvent) => void): Promise<void> {
  const channel = new Channel<SidecarChannelEvent>();
  channel.onmessage = onEvent;
  await invoke("start_sidecar", { onEvent: channel });
}

export async function sendHost(msg: HostMessage): Promise<void> {
  await invoke("sidecar_send", { line: JSON.stringify(msg) });
}

export async function stopSidecar(): Promise<void> {
  await invoke("stop_sidecar");
}
