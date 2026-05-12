import { type ProtopieMcpToolResult } from './types';

export const jsonToolResponse = (payload: unknown): ProtopieMcpToolResult => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
        },
    ],
});
