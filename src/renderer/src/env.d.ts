import type { PingoAPI } from "../../shared/types.js"

/// <reference types="vite/client" />

declare global {
  interface Window {
    pingo: PingoAPI
  }
}
