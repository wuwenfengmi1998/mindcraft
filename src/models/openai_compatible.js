import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';

/**
 * Generic OpenAI-compatible model used by user-defined providers.
 * The provider URL and API key are injected by the dynamic subclass
 * created in _model_map.js, so secrets never need to be stored in a bot profile.
 */
export class OpenAICompatible {
    constructor(model_name, url, params, apiKey) {
        this.model_name = model_name || null;
        this.params = params || {};
        this.url = url;
        this.openai = new OpenAIApi({
            baseURL: url,
            apiKey: apiKey || 'not-needed',
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        const model = this.model_name || 'default';
        const pack = {
            model,
            messages,
            ...(this.params || {}),
        };
        // Reasoning-style models commonly reject `stop`.
        if (!(String(model).includes('o1') || String(model).includes('o3') || String(model).includes('5'))) {
            pack.stop = stop_seq;
        }

        let res = null;
        try {
            console.log(`Awaiting custom provider response from model ${model}`);
            const completion = await this.openai.chat.completions.create(pack);
            if (completion.choices?.[0]?.finish_reason === 'length') {
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = completion.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            if (String(err.message || '').includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.error('Custom provider error:', err.message || err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
                    },
                },
            ],
        });
        return await this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191) text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-3-small',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
