import type { PingoAPI } from "../../shared/types.js"

/// <reference types="vite/client" />

declare module "*.webm" {
  const src: string
  export default src
}

declare global {
  interface Window {
    pingo: PingoAPI
  }
}
