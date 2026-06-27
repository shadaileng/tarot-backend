import { ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { config } from './config.js'

let currentProxyUrl = ''
let proxyAgent: ProxyAgent | undefined

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = config.httpsProxy?.trim()
  if (!proxyUrl) {
    if (proxyAgent) {
      proxyAgent.close()
      proxyAgent = undefined
    }
    currentProxyUrl = ''
    return undefined
  }
  if (proxyUrl !== currentProxyUrl) {
    if (proxyAgent) proxyAgent.close()
    proxyAgent = new ProxyAgent(proxyUrl)
    currentProxyUrl = proxyUrl
  }
  return proxyAgent
}

export async function fetchWithProxy(
  url: string | URL,
  options?: RequestInit,
): Promise<Response> {
  const dispatcher = getProxyDispatcher()
  if (dispatcher) {
    return (fetch as any)(url, { ...options, dispatcher })
  }
  return fetch(url, options)
}
