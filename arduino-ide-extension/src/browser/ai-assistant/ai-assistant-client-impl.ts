import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import type {
  AiAssistantClient,
  AiStreamChunk,
} from '../../common/protocol/ai-assistant-service';

@injectable()
export class AiAssistantClientImpl implements AiAssistantClient {
  private readonly onStreamChunkEmitter = new Emitter<AiStreamChunk>();

  readonly onDidReceiveStreamChunk: Event<AiStreamChunk> =
    this.onStreamChunkEmitter.event;

  onStreamChunk(chunk: AiStreamChunk): void {
    this.onStreamChunkEmitter.fire(chunk);
  }

  dispose(): void {
    this.onStreamChunkEmitter.dispose();
  }
}
