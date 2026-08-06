import { getAdapter } from './adapters/index.js';
import { executeRequest } from './request-pipeline.js';

export async function sendOpenAIImageRequest(
    endpoint,
    apiKey,
    model,
    signal = null,
    adapter = null,
    requestContext = null
) {
    return executeRequest(adapter || getAdapter('openai-image'), {
        endpoint,
        apiKey,
        model,
        signal,
        sessionId: requestContext?.sessionId,
        sourceMessages: requestContext?.sourceMessages,
        requestProfile: requestContext?.requestProfile
    });
}
