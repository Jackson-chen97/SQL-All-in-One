import { FormatOptionsWithLanguage, format } from "../formatter/sqlFormatter"
import { preprocessSparkSql, postprocessSparkSql } from "../formatter/SparkSqlAdapter"
import { preprocessHiveSql, postprocessHiveSql } from "../formatter/HiveSqlAdapter"
import { preprocessFlinkSql, postprocessFlinkSql } from "../formatter/FlinkSqlAdapter"
import { extract as extractComments, restore as restoreComments } from "../formatter/CommentPreserver"
import { handleError, ErrorCategory } from "../core/errorHandler"

/**
 * Format column definitions in materialized view DDL.
 * Ensures each column with its COMMENT is on a separate line.
 * Example: `col` COMMENT "desc",
 */
function formatMvColumnDefs(sql: string): string {
    // Match CREATE MATERIALIZED VIEW ... ( columns ) pattern
    const mvPattern = /^((?:CREATE\s+MATERIALIZED\s+VIEW\s+[`"']?\w+[`"']?\s*))\(/i
    const match = sql.match(mvPattern)
    if (!match) return sql

    const prefix = match[0]
    const startIdx = prefix.length

    // Find the matching closing paren
    let depth = 1
    let i = startIdx
    let inQuote = false
    let quoteChar = ''
    while (i < sql.length && depth > 0) {
        const ch = sql[i]
        if (inQuote) {
            if (ch === quoteChar && sql[i - 1] !== '\\') { inQuote = false }
            i++
            continue
        }
        if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; i++; continue }
        if (ch === '(') { depth++; i++; continue }
        if (ch === ')') { depth--; if (depth === 0) break; i++; continue }
        i++
    }
    if (depth !== 0) return sql

    const endIdx = i
    const inner = sql.substring(startIdx, endIdx)

    // Parse individual column definitions
    // Each column: `col_name` COMMENT "comment_text"
    const columns: string[] = []
    let current = ''
    let colDepth = 0
    let colInQuote = false
    let colQuoteChar = ''

    for (let j = 0; j < inner.length; j++) {
        const ch = inner[j]
        if (colInQuote) {
            current += ch
            if (ch === colQuoteChar && inner[j - 1] !== '\\') { colInQuote = false }
            continue
        }
        if (ch === '"' || ch === "'") {
            colInQuote = true
            colQuoteChar = ch
            current += ch
            continue
        }
        if (ch === '(') { colDepth++; current += ch; continue }
        if (ch === ')') { colDepth--; current += ch; continue }

        if (ch === ',' && colDepth === 0) {
            const trimmed = current.trim()
            if (trimmed) columns.push(trimmed)
            current = ''
            continue
        }
        current += ch
    }
    const lastTrimmed = current.trim()
    if (lastTrimmed) columns.push(lastTrimmed)

    if (columns.length === 0) return sql

    // Format each column on its own line with 4-space indent
    const formattedCols = columns.map(col => '    ' + col)

    // Reconstruct the SQL
    return sql.substring(0, startIdx) +
        '\n' + formattedCols.join(',\n') + '\n' +
        sql.substring(endIdx)
}

export function formatEditorText(
    text: string,
    config: FormatOptionsWithLanguage,
): string {
    // Pre-process: format materialized view column definitions
    const preprocessed = formatMvColumnDefs(text)

    const { processedSql, slots } = extractComments(preprocessed)

    let formatted: string
    if (config.language === 'spark') {
        formatted = formatSparkSql(processedSql, config)
    } else if (config.language === 'hive') {
        formatted = formatHiveSql(processedSql, config)
    } else if (config.language === 'flinksql') {
        formatted = formatFlinkSql(processedSql, config)
    } else {
        formatted = formatWithFallback(processedSql, config)
    }

    formatted = restoreComments(formatted, slots)

    return formatted + (endsWithNewline(text) ? "\n" : "")
}

function formatSparkSql(
    sql: string,
    config: FormatOptionsWithLanguage,
): string {
    const { processedSql, state } = preprocessSparkSql(sql)

    const formatted = formatWithFallback(processedSql, config)

    return postprocessSparkSql(formatted, state)
}

function formatHiveSql(
    sql: string,
    config: FormatOptionsWithLanguage,
): string {
    const { processedSql, state } = preprocessHiveSql(sql)

    const formatted = formatWithFallback(processedSql, config)

    return postprocessHiveSql(formatted, state)
}

function formatFlinkSql(
    sql: string,
    config: FormatOptionsWithLanguage,
): string {
    const { processedSql, state } = preprocessFlinkSql(sql)

    const formatted = formatWithFallback(processedSql, config)

    return postprocessFlinkSql(formatted, state)
}

function formatWithFallback(
    sql: string,
    config: FormatOptionsWithLanguage,
): string {
    try {
        return format(sql, config)
    } catch (e) {
        // Try partial SQL formatting before falling back to original
        const partialResult = formatPartialSql(sql, config)
        if (partialResult !== null) {
            return partialResult
        }
        const sqlPreview = sql.length > 200 ? sql.substring(0, 200) + '...' : sql
        handleError(e, `formatWithFallback (sql: ${sqlPreview})`, ErrorCategory.FORMAT)
        return sql
    }
}

/**
 * Attempts to format incomplete SQL by appending minimal completion tokens
 * (e.g. `AND 1=1`, closing `)`, table alias) so the parser can handle it,
 * then strips those tokens from the formatted output.
 *
 * Returns the formatted partial SQL, or null if the SQL cannot be completed
 * or formatting still fails.
 */
function formatPartialSql(
    sql: string,
    config: FormatOptionsWithLanguage,
): string | null {
    const { completed, completion } = completePartialSql(sql)
    if (completed === sql) {
        return null // no completion was added; nothing to do
    }

    let formatted: string
    try {
        formatted = format(completed, config)
    } catch {
        return null
    }

    return stripCompletion(formatted, completion)
}

interface PartialCompletion {
    addedWhere11: boolean
    addedAnd11: boolean
    addedBetweenAnd: boolean
    addedInVal: boolean
    closedParens: number
    addedAlias: boolean
    addedFromDummy: boolean
}

function completePartialSql(sql: string): { completed: string; completion: PartialCompletion } {
    let result = sql.trimEnd()
    const completion: PartialCompletion = {
        addedWhere11: false,
        addedAnd11: false,
        addedBetweenAnd: false,
        addedInVal: false,
        closedParens: 0,
        addedAlias: false,
        addedFromDummy: false,
    }

    // Track string state and paren depth (ignoring strings/comments)
    let depth = 0
    let inStr = false
    let strChar = ''
    for (let i = 0; i < result.length; i++) {
        const c = result[i]
        if (inStr) {
            if (c === strChar && result[i - 1] !== '\\') inStr = false
            continue
        }
        if (c === "'" || c === '"' || c === '`') {
            inStr = true
            strChar = c
            continue
        }
        if (c === '(') depth++
        if (c === ')') depth--
    }

    // Balanced parens and complete string — only fix trailing keywords
    if (depth <= 0 && !inStr) {
        if (/\b(WHERE|AND|OR)\s*$/i.test(result)) {
            result += ' 1=1'
            completion.addedWhere11 = true
        } else if (/\bBETWEEN\s+\S+\s*$/i.test(result) && !/\bBETWEEN\s+\S+\s+AND\b/i.test(result)) {
            result += ' AND 1'
            completion.addedBetweenAnd = true
        }
        return { completed: result, completion }
    }

    // Close unclosed string literals
    if (inStr) result += strChar

    // Handle incomplete IN(...) — "IN (1,2,3" needs ",1)"
    if (/\bIN\s*\([^)]*$/.test(result)) {
        if (/,\s*$/.test(result)) {
            result += '1)'
        } else {
            result += ',1)'
        }
        depth--
        completion.addedInVal = true
    } else if (/\bFROM\s*\(/.test(result) && depth > 0) {
        // Subquery: FROM (SELECT ...
        const subMatch = result.match(/\bFROM\s*\(\s*(SELECT\s+[^)]*)$/i)
        if (subMatch && !/\bFROM\b/i.test(subMatch[1])) {
            // SELECT without FROM inside subquery — add dummy FROM
            result += ' FROM __dummy__'
            completion.addedFromDummy = true
        }
        if (/\bWHERE\b/i.test(result) && !/\bGROUP\s+BY\b/i.test(result)) {
            result += ' AND 1=1'
            completion.addedAnd11 = true
        }
    } else if (/\b(WHERE|AND|OR)\s*$/i.test(result)) {
        result += ' 1=1'
        completion.addedWhere11 = true
    } else if (/\bBETWEEN\s+\S+\s*$/i.test(result) && !/\bBETWEEN\s+\S+\s+AND\b/i.test(result)) {
        result += ' AND 1'
        completion.addedBetweenAnd = true
    } else if (depth > 0) {
        // Unclosed parens after a complete expression — add AND 1=1 before closing
        result += ' AND 1=1'
        completion.addedAnd11 = true
    }

    // Close unclosed parens
    while (depth > 0) {
        result += ')'
        completion.closedParens++
        depth--
    }
    // If closing a subquery, add alias
    if (completion.closedParens > 0 && /\bFROM\s*\(/.test(result)) {
        result += ' AS __sub__'
        completion.addedAlias = true
    }

    return { completed: result, completion }
}

function stripCompletion(formatted: string, completion: PartialCompletion): string {
    let result = formatted

    // Remove trailing semicolon
    result = result.replace(/;?\s*$/, '')

    // Remove AS __sub__ alias
    if (completion.addedAlias) {
        result = result.replace(/\bAS\s+__sub__\s*$/i, '')
    }

    // Remove closed parens (count from the end)
    if (completion.closedParens > 0) {
        let count = completion.closedParens
        while (count > 0 && /\)\s*$/.test(result)) {
            result = result.replace(/\)\s*$/, '')
            count--
        }
    }

    // Remove AND 1=1 (formatted may have spaces: "AND 1 = 1")
    if (completion.addedAnd11) {
        result = result.replace(/\bAND\s+1\s*=\s*1\s*$/i, '')
    }

    // Remove WHERE 1=1 / AND 1=1 (if we added it to close a WHERE)
    if (completion.addedWhere11) {
        result = result.replace(/\bWHERE\s+1\s*=\s*1\s*$/i, '')
        result = result.replace(/\bAND\s+1\s*=\s*1\s*$/i, '')
    }

    // Remove AND 1 (BETWEEN completion)
    if (completion.addedBetweenAnd) {
        result = result.replace(/\bAND\s+1\s*$/i, '')
    }

    // Remove the dummy IN value (",1" or "1") and its closing )
    if (completion.addedInVal) {
        result = result.replace(/\)\s*$/, '')
        result = result.replace(/,\s*1\s*$/i, '')
    }

    // Remove FROM __dummy__
    if (completion.addedFromDummy) {
        result = result.replace(/\bFROM\s+__dummy__\s*$/i, '')
    }

    // Clean up trailing whitespace and commas
    result = result.replace(/[,\s]+$/, '')

    return result
}

const endsWithNewline = (text: string): boolean => /\n$/.test(text)
