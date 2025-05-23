import Ajv from 'ajv';

const ajv = new Ajv.default({ allErrors: true });

// Define common schemas for data validation
const jsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: true, // Allow additional properties by default
};

export const schemas = {
    conversationMessage: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            user_id: { type: ['string', 'null'] },
            sender: { type: 'string' },
            message_content: { type: 'string' },
            message_type: { type: 'string', default: 'text' },
            tool_info: { type: ['string', 'null'] },
            context_snapshot_id: { type: ['string', 'null'] },
            source_attribution_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'sender', 'message_content'],
        additionalProperties: false,
    },
    contextInformation: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            context_data: { type: 'object' }, // Assuming context_data is always a JSON object
            parent_context_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'context_type', 'context_data'],
        additionalProperties: false,
    },
    referenceKey: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            key_type: { type: 'string' },
            key_value: { type: 'string' },
            description: { type: ['string', 'null'] },
            associated_conversation_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'key_type', 'key_value'],
        additionalProperties: false,
    },
    sourceAttribution: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            source_type: { type: 'string' },
            source_uri: { type: ['string', 'null'] },
            retrieval_timestamp: { type: 'number' },
            content_summary: { type: ['string', 'null'] },
            full_content_hash: { type: ['string', 'null'] },
            full_content_json: { type: ['string', 'null'] }, // New property
        },
        required: ['agent_id', 'source_type', 'retrieval_timestamp'],
        additionalProperties: false,
    },
    correctionLog: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            correction_type: { type: 'string' },
            original_entry_id: { type: ['string', 'null'] },
            original_value: { type: ['object', 'null'] },
            corrected_value: { type: ['object', 'null'] },
            reason: { type: ['string', 'null'] },
            applied_automatically: { type: 'boolean' },
        },
        required: ['agent_id', 'correction_type', 'applied_automatically'],
        additionalProperties: false,
    },
    successMetric: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            metric_name: { type: 'string' },
            metric_value: { type: 'number' },
            unit: { type: ['string', 'null'] },
            associated_task_id: { type: ['string', 'null'] },
            metadata: { type: ['object', 'null'] },
        },
        required: ['agent_id', 'metric_name', 'metric_value'],
        additionalProperties: false,
    },
    tavilySearch: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            search_depth: { type: 'string', enum: ['basic', 'advanced'] },
            max_results: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
    },
    searchContextByKeywords: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            keywords: { type: 'string' }
        },
        required: ['agent_id', 'context_type', 'keywords'],
        additionalProperties: false,
    },
    pruneOldContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: ['string', 'null'] },
            max_age_ms: { type: 'number' }
        },
        required: ['agent_id', 'max_age_ms'],
        additionalProperties: false,
    },
    summarizeContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            version: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'context_type'],
        additionalProperties: false,
    },
    extractEntities: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            version: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'context_type'],
        additionalProperties: false,
    },
    semanticSearchContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            query_text: { type: 'string' },
            top_k: { type: 'number', minimum: 1 }
        },
        required: ['agent_id', 'context_type', 'query_text'],
        additionalProperties: false,
    },
    analyzeImageContent: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            image_path: { type: 'string' },
            mime_type: { type: 'string' },
            prompt: { type: 'string' }
        },
        required: ['agent_id', 'image_path', 'mime_type', 'prompt'],
        additionalProperties: false,
    },
    exportDataToCsv: {
        type: 'object',
        properties: {
            tableName: { type: 'string' },
            filePath: { type: 'string' }
        },
        required: ['tableName', 'filePath'],
        additionalProperties: false,
    },
    backupDatabase: {
        type: 'object',
        properties: {
            backupFilePath: { type: 'string' }
        },
        required: ['backupFilePath'],
        additionalProperties: false,
    },
    restoreDatabase: {
        type: 'object',
        properties: {
            backupFilePath: { type: 'string' }
        },
        required: ['backupFilePath'],
        additionalProperties: false,
    },
};

// Compile schemas
for (const key in schemas) {
    if (Object.prototype.hasOwnProperty.call(schemas, key)) {
        ajv.addSchema((schemas as any)[key], key);
    }
}

export function validate(schemaName: string, data: any) {
    const validateFn = ajv.getSchema(schemaName);
    if (!validateFn) {
        throw new Error(`Schema "${schemaName}" not found.`);
    }
    const valid = validateFn(data);
    if (!valid) {
        return { valid: false, errors: validateFn.errors };
    }
    return { valid: true, errors: null };
}
