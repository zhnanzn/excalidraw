import type { StoreDelta } from "../store";
import type { DTO } from "../utility-types";

export type CLIENT_DELTA = DTO<StoreDelta>;

export type RELAY_PAYLOAD = { buffer: ArrayBuffer };
export type PULL_PAYLOAD = { lastAcknowledgedVersion: number };
export type PUSH_PAYLOAD = CLIENT_DELTA;

export type CHUNK_INFO = {
  id: string;
  position: number;
  count: number;
};

export type CLIENT_MESSAGE_RAW = {
  type: "relay" | "pull" | "push";
  payload: string;
  chunkInfo?: CHUNK_INFO;
};

export type CLIENT_MESSAGE = { chunkInfo: CHUNK_INFO } & (
  | { type: "relay"; payload: RELAY_PAYLOAD }
  | { type: "pull"; payload: PULL_PAYLOAD }
  | { type: "push"; payload: PUSH_PAYLOAD }
);

export type SERVER_DELTA = { id: string; version: number; payload: string };
export type SERVER_MESSAGE =
  | {
      type: "relayed";
      // CFDO: should likely be just elements
      // payload: { deltas: Array<CLIENT_DELTA> } | RELAY_PAYLOAD;
    }
  | { type: "acknowledged"; payload: { deltas: Array<SERVER_DELTA> } }
  | {
      type: "rejected";
      payload: { deltas: Array<CLIENT_DELTA>; message: string };
    };

export interface DeltasRepository {
  save(delta: CLIENT_DELTA): SERVER_DELTA | null;
  getAllSinceVersion(version: number): Array<SERVER_DELTA>;
  getLastVersion(): number;
}

// CFDO: should come from the shared types package
export type ExcalidrawElement = {
  id: string;
  type: any;
  version: number;
  [key: string]: any;
};
