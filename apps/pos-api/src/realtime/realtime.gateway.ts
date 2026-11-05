// Socket.IO channel (REQ-116). After each committed write the queue hands
// the change's events here and they go to every connected device. Rejected
// writes queue no events, so nothing is sent for them. Events are small
// (ids and new state); a device that reconnects refetches its GET endpoints.
import { OnModuleDestroy } from '@nestjs/common';
import { OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { RealtimeEvent } from '@dhaba/shared';
import type { Server } from 'socket.io';
import { WriteQueue } from '../storage/write-queue';

/** Envelope of every event: the payload plus when it was committed and its journal seq. */
export interface RealtimeMessage {
  seq: number;
  at: string;
  [key: string]: unknown;
}

@WebSocketGateway({ path: '/socket.io', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private active = true;

  constructor(queue: WriteQueue) {
    queue.onCommit((entry, events) => {
      for (const e of events) this.broadcast(e.event, { ...e.payload, seq: entry.seq, at: entry.at });
    });
  }

  afterInit(): void {
    this.active = true;
  }

  /** Sends one event to every connected device. */
  broadcast(event: RealtimeEvent, message: RealtimeMessage): void {
    if (this.active && this.server) this.server.emit(event, message);
  }

  onModuleDestroy(): void {
    this.active = false;
  }
}
