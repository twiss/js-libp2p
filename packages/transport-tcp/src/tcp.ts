/**
 * @packageDocumentation
 *
 * A [libp2p transport](https://docs.libp2p.io/concepts/transports/overview/) based on the TCP networking stack.
 *
 * @example
 *
 * ```TypeScript
 * import { createLibp2p } from 'libp2p'
 * import { tcp } from '@libp2p/tcp'
 * import { multiaddr } from '@multiformats/multiaddr'
 *
 * const node = await createLibp2p({
 *   transports: [
 *     tcp()
 *   ]
 * })
 *
 * const ma = multiaddr('/ip4/123.123.123.123/tcp/1234')
 *
 * // dial a TCP connection, timing out after 10 seconds
 * const connection = await node.dial(ma, {
 *   signal: AbortSignal.timeout(10_000)
 * })
 *
 * // use connection...
 * ```
 */

import net from 'net'
import { AbortError, TimeoutError, serviceCapabilities, transportSymbol } from '@libp2p/interface'
import * as mafmt from '@multiformats/mafmt'
import { CustomProgressEvent } from 'progress-events'
import { CODE_CIRCUIT, CODE_P2P, CODE_UNIX } from './constants.js'
import { TCPListener } from './listener.js'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { multiaddrToNetConfig } from './utils.js'
import type { TCPComponents, TCPCreateListenerOptions, TCPDialEvents, TCPDialOptions, TCPMetrics, TCPOptions } from './index.js'
import type { Logger, Connection, Transport, Listener } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { Socket, IpcSocketConnectOpts, TcpSocketConnectOpts } from 'net'

export class TCP implements Transport<TCPDialEvents> {
  private readonly opts: TCPOptions
  private readonly metrics?: TCPMetrics
  private readonly components: TCPComponents
  private readonly log: Logger

  constructor (components: TCPComponents, options: TCPOptions = {}) {
    this.log = components.logger.forComponent('libp2p:tcp')
    this.opts = options
    this.components = components

    if (components.metrics != null) {
      this.metrics = {
        dialerEvents: components.metrics.registerCounterGroup('libp2p_tcp_dialer_events_total', {
          label: 'event',
          help: 'Total count of TCP dialer events by type'
        })
      }
    }
  }

  readonly [transportSymbol] = true

  readonly [Symbol.toStringTag] = '@libp2p/tcp'

  readonly [serviceCapabilities]: string[] = [
    '@libp2p/transport'
  ]

  async dial (ma: Multiaddr, options: TCPDialOptions): Promise<Connection> {
    options.keepAlive = options.keepAlive ?? true
    options.noDelay = options.noDelay ?? true

    // options.signal destroys the socket before 'connect' event
    const socket = await this._connect(ma, options)

    // Avoid uncaught errors caused by unstable connections
    socket.on('error', err => {
      this.log('socket error', err)
    })

    const maConn = toMultiaddrConnection(socket, {
      remoteAddr: ma,
      socketInactivityTimeout: this.opts.outboundSocketInactivityTimeout,
      socketCloseTimeout: this.opts.socketCloseTimeout,
      metrics: this.metrics?.dialerEvents,
      logger: this.components.logger
    })

    const onAbort = (): void => {
      maConn.close().catch(err => {
        this.log.error('Error closing maConn after abort', err)
      })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    this.log('new outbound connection %s', maConn.remoteAddr)
    const conn = await options.upgrader.upgradeOutbound(maConn)
    this.log('outbound connection %s upgraded', maConn.remoteAddr)

    options.signal?.removeEventListener('abort', onAbort)

    if (options.signal?.aborted === true) {
      conn.close().catch(err => {
        this.log.error('Error closing conn after abort', err)
      })

      throw new AbortError()
    }

    return conn
  }

  async _connect (ma: Multiaddr, options: TCPDialOptions): Promise<Socket> {
    options.signal?.throwIfAborted()
    options.onProgress?.(new CustomProgressEvent('tcp:open-connection'))

    return new Promise<Socket>((resolve, reject) => {
      const start = Date.now()
      const cOpts = multiaddrToNetConfig(ma, {
        ...(this.opts.dialOpts ?? {}),
        ...options
      }) as (IpcSocketConnectOpts & TcpSocketConnectOpts)

      this.log('dialing %a', ma)
      const rawSocket = net.connect(cOpts)

      const onError = (err: Error): void => {
        const cOptsStr = cOpts.path ?? `${cOpts.host ?? ''}:${cOpts.port}`
        err.message = `connection error ${cOptsStr}: ${err.message}`
        this.metrics?.dialerEvents.increment({ error: true })

        done(err)
      }

      const onTimeout = (): void => {
        this.log('connection timeout %a', ma)
        this.metrics?.dialerEvents.increment({ timeout: true })

        const err = new TimeoutError(`connection timeout after ${Date.now() - start}ms`)
        // Note: this will result in onError() being called
        rawSocket.emit('error', err)
      }

      const onConnect = (): void => {
        this.log('connection opened %a', ma)
        this.metrics?.dialerEvents.increment({ connect: true })
        done()
      }

      const onAbort = (): void => {
        this.log('connection aborted %a', ma)
        this.metrics?.dialerEvents.increment({ abort: true })
        rawSocket.destroy()
        done(new AbortError())
      }

      const done = (err?: Error): void => {
        rawSocket.removeListener('error', onError)
        rawSocket.removeListener('timeout', onTimeout)
        rawSocket.removeListener('connect', onConnect)

        if (options.signal != null) {
          options.signal.removeEventListener('abort', onAbort)
        }

        if (err != null) {
          reject(err); return
        }

        resolve(rawSocket)
      }

      rawSocket.on('error', onError)
      rawSocket.on('timeout', onTimeout)
      rawSocket.on('connect', onConnect)

      if (options.signal != null) {
        options.signal.addEventListener('abort', onAbort)
      }
    })
  }

  /**
   * Creates a TCP listener. The provided `handler` function will be called
   * anytime a new incoming Connection has been successfully upgraded via
   * `upgrader.upgradeInbound`.
   */
  createListener (options: TCPCreateListenerOptions): Listener {
    return new TCPListener({
      ...(this.opts.listenOpts ?? {}),
      ...options,
      maxConnections: this.opts.maxConnections,
      backlog: this.opts.backlog,
      closeServerOnMaxConnections: this.opts.closeServerOnMaxConnections,
      socketInactivityTimeout: this.opts.inboundSocketInactivityTimeout,
      socketCloseTimeout: this.opts.socketCloseTimeout,
      metrics: this.components.metrics,
      logger: this.components.logger
    })
  }

  /**
   * Takes a list of `Multiaddr`s and returns only valid TCP addresses
   */
  listenFilter (multiaddrs: Multiaddr[]): Multiaddr[] {
    multiaddrs = Array.isArray(multiaddrs) ? multiaddrs : [multiaddrs]

    return multiaddrs.filter(ma => {
      if (ma.protoCodes().includes(CODE_CIRCUIT)) {
        return false
      }

      if (ma.protoCodes().includes(CODE_UNIX)) {
        return true
      }

      return mafmt.TCP.matches(ma.decapsulateCode(CODE_P2P))
    })
  }

  /**
   * Filter check for all Multiaddrs that this transport can dial
   */
  dialFilter (multiaddrs: Multiaddr[]): Multiaddr[] {
    return this.listenFilter(multiaddrs)
  }
}
