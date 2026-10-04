/**
 * @typedef {object} ToolDefinition
 * @property {string} name                      cookie_ prefixed
 * @property {string} title
 * @property {string} description
 * @property {import('zod').ZodObject<any>} inputSchema
 * @property {import('zod').ZodObject<any>} [outputSchema]
 * @property {{readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean}} annotations
 * @property {(args: any, api: import('../api.js').Api) => Promise<Record<string, unknown>>} run
 *   Returns the structured result. Throws ApiError (from api.js) or ToolInputError (results.js) on failure.
 */

export {};
