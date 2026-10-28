import type { KumiApi } from '../shared/types'

declare global {
  interface Window {
    kumi: KumiApi
  }
}

export {}
