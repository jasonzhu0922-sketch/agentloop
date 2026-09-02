import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip") as {
  loadAsync(data: Buffer): Promise<ZipArchive>;
};

const XLSX_PROFILE_MAX_BYTES = 25 * 1024 * 1024;
const CSV_PROFILE_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_FILE_LIMIT = 200;
const PROFILE_WORKSHEET_LIMIT = 20;
const PROFILE_HEADER_SCAN_ROWS = 20;
const PROFILE_HEADER_VALUE_LIMIT = 24;
const PROFILE_MERGE_SAMPLE_LIMIT = 12;
const CSV_PROFILE_MAX_ROWS = 5_000;
const EXTRACT_FILE_LIMIT = 50;
const EXTRACT_ROWS_PER_SHEET_LIMIT = 2_000;
const EXTRACT_TOTAL_CELL_LIMIT = 100_000;

interface ZipArchive {
  readonly file: (path: string) => ZipFile | null;
}

interface ZipFile {
  readonly async: (type: "string") => Promise<string>;
}

export interface SpreadsheetFileEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface SpreadsheetProfileOptions {
  readonly maxFiles?: number;
}

export interface SpreadsheetExtractionOptions {
  readonly maxRowsPerSheet?: number;
  readonly maxTotalCells?: number;
}

export interface SpreadsheetCell {
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly value?: string | number | boolean;
  readonly valueKind: "text" | "number" | "boolean" | "formula" | "blank" | "unknown";
  readonly formula?: string;
}

export interface SpreadsheetRow {
  readonly row: number;
  readonly cells: readonly SpreadsheetCell[];
}

export interface SpreadsheetWorksheetProfile {
  readonly name: string;
  readonly index: number;
  readonly declaredRange?: string;
  readonly observedRange?: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly nonEmptyCellCount: number;
  readonly mergedCellCount: number;
  readonly mergedCellSamples: readonly string[];
  readonly formulaCellCount: number;
  readonly valueKinds: Record<string, number>;
  readonly candidateHeaders: readonly SpreadsheetHeaderCandidate[];
}

export interface SpreadsheetHeaderCandidate {
  readonly row: number;
  readonly range: string;
  readonly nonEmptyCellCount: number;
  readonly values: readonly string[];
}

export interface SpreadsheetFileProfile {
  readonly path: string;
  readonly extension: string;
  readonly bytes: number;
  readonly workbookType: "xlsx" | "xlsm" | "csv";
  readonly sheetCount: number;
  readonly sheets: readonly SpreadsheetWorksheetProfile[];
  readonly signature: string;
  readonly truncated: boolean;
  readonly caveats: readonly string[];
  readonly error?: string;
}

export interface SpreadsheetDirectoryProfile {
  readonly schema: "agentloop.spreadsheetProfile/v1";
  readonly workbookCount: number;
  readonly profiledWorkbookCount: number;
  readonly truncated: boolean;
  readonly signatures: readonly SpreadsheetSignatureGroup[];
  readonly files: readonly SpreadsheetFileProfile[];
  readonly caveats: readonly string[];
}

export interface SpreadsheetSignatureGroup {
  readonly signature: string;
  readonly count: number;
  readonly samplePaths: readonly string[];
  readonly sheetNames: readonly string[];
  readonly sheetShapes: readonly string[];
}

export interface SpreadsheetExtractionFile {
  readonly path: string;
  readonly extension: string;
  readonly bytes: number;
  readonly workbookType: "xlsx" | "xlsm" | "csv";
  readonly sheets: readonly SpreadsheetExtractionSheet[];
  readonly sha256: string;
  readonly truncated: boolean;
  readonly caveats: readonly string[];
  readonly error?: string;
}

export interface SpreadsheetExtractionSheet {
  readonly name: string;
  readonly index: number;
  readonly sourceRange?: string;
  readonly header?: SpreadsheetHeaderCandidate;
  readonly columns: readonly SpreadsheetExtractionColumn[];
  readonly rows: readonly SpreadsheetRow[];
  readonly records: readonly SpreadsheetExtractionRecord[];
  readonly rowCount: number;
  readonly recordCount: number;
  readonly cellCount: number;
  readonly truncated: boolean;
}

export interface SpreadsheetExtractionColumn {
  readonly index: number;
  readonly address: string;
  readonly name: string;
  readonly sourceAddress?: string;
  readonly nonEmptyCellCount: number;
  readonly valueKinds: Record<string, number>;
}

export interface SpreadsheetExtractionRecord {
  readonly row: number;
  readonly sourceRange: string;
  readonly values: Record<string, string | number | boolean>;
  readonly cellCount: number;
}

export interface SpreadsheetExtractionPayload {
  readonly schema: "agentloop.visibleTableExtraction/v1";
  readonly files: readonly SpreadsheetExtractionFile[];
  readonly requested: number;
  readonly returned: number;
  readonly totalRows: number;
  readonly totalRecords: number;
  readonly totalCells: number;
  readonly truncated: boolean;
  readonly caveats: readonly string[];
  readonly sha256: string;
}

interface ParsedWorksheet {
  readonly name: string;
  readonly index: number;
  readonly declaredRange?: string;
  readonly observedRange?: string;
  readonly mergedCellRefs: readonly string[];
  readonly rows: readonly SpreadsheetRow[];
  readonly truncated: boolean;
}

interface WorkbookSheetEntry {
  readonly name: string;
  readonly path: string;
}

export async function profileSpreadsheets(
  rootPath: string,
  files: readonly SpreadsheetFileEntry[],
  options: SpreadsheetProfileOptions = {},
): Promise<SpreadsheetDirectoryProfile> {
  const candidates = files.filter(isSpreadsheetLikePath);
  const maxFiles = Math.min(Math.max(1, options.maxFiles ?? PROFILE_FILE_LIMIT), PROFILE_FILE_LIMIT);
  const selected = candidates.slice(0, maxFiles);
  const profiles = await Promise.all(selected.map((file) => profileSpreadsheetFile(rootPath, file)));
  const truncated = candidates.length > selected.length || profiles.some((profile) => profile.truncated);
  const caveats = [
    ...(candidates.length > selected.length ? [`Spreadsheet profiling stopped at ${selected.length} of ${candidates.length} candidate workbooks.`] : []),
    ...uniqueStrings(profiles.flatMap((profile) => profile.caveats)),
  ];
  return {
    schema: "agentloop.spreadsheetProfile/v1",
    workbookCount: candidates.length,
    profiledWorkbookCount: profiles.length,
    truncated,
    signatures: spreadsheetSignatureGroups(profiles),
    files: profiles,
    caveats,
  };
}

export async function extractSpreadsheetTables(
  rootPath: string,
  files: readonly SpreadsheetFileEntry[],
  options: SpreadsheetExtractionOptions = {},
): Promise<SpreadsheetExtractionPayload> {
  const maxRowsPerSheet = Math.min(Math.max(1, options.maxRowsPerSheet ?? 500), EXTRACT_ROWS_PER_SHEET_LIMIT);
  const maxTotalCells = Math.min(Math.max(1, options.maxTotalCells ?? 20_000), EXTRACT_TOTAL_CELL_LIMIT);
  const candidates = files.filter(isSpreadsheetLikePath);
  const selected = candidates.slice(0, EXTRACT_FILE_LIMIT);
  const output: SpreadsheetExtractionFile[] = [];
  let usedCells = 0;
  let truncated = candidates.length > selected.length;
  for (const file of selected) {
    if (usedCells >= maxTotalCells) {
      truncated = true;
      break;
    }
    const remainingCells = maxTotalCells - usedCells;
    const extracted = await extractSpreadsheetFile(rootPath, file, {
      maxRowsPerSheet,
      maxTotalCells: remainingCells,
    });
    usedCells += extracted.sheets.reduce((sum, sheet) => sum + sheet.cellCount, 0);
    truncated = truncated || extracted.truncated;
    output.push(extracted);
  }
  const caveats = [
    ...(files.length > candidates.length ? [`Table extraction ignored ${files.length - candidates.length} non-spreadsheet requested files.`] : []),
    ...(candidates.length > selected.length ? [`Table extraction stopped at ${selected.length} of ${candidates.length} spreadsheet files.`] : []),
    ...uniqueStrings(output.flatMap((file) => file.caveats)),
  ];
  const material = JSON.stringify({ files: output, caveats, maxRowsPerSheet, maxTotalCells });
  return {
    schema: "agentloop.visibleTableExtraction/v1",
    files: output,
    requested: files.length,
    returned: output.length,
    totalRows: output.reduce((sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.rowCount, 0), 0),
    totalRecords: output.reduce((sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.recordCount, 0), 0),
    totalCells: usedCells,
    truncated,
    caveats,
    sha256: createHash("sha256").update(material).digest("hex"),
  };
}

function isSpreadsheetLikePath(file: SpreadsheetFileEntry): boolean {
  const extension = extname(file.path).toLowerCase();
  return extension === ".xlsx" || extension === ".xlsm" || extension === ".csv";
}

async function profileSpreadsheetFile(rootPath: string, file: SpreadsheetFileEntry): Promise<SpreadsheetFileProfile> {
  const extension = extname(file.path).toLowerCase();
  const workbookType = spreadsheetWorkbookType(extension);
  const caveats: string[] = [];
  try {
    if ((workbookType === "xlsx" || workbookType === "xlsm") && file.bytes > XLSX_PROFILE_MAX_BYTES) {
      return errorProfile(file, workbookType, "file_too_large", [`Workbook exceeds ${XLSX_PROFILE_MAX_BYTES} bytes and was not profiled.`]);
    }
    if (workbookType === "csv" && file.bytes > CSV_PROFILE_MAX_BYTES) {
      return errorProfile(file, workbookType, "file_too_large", [`CSV exceeds ${CSV_PROFILE_MAX_BYTES} bytes and was not profiled.`]);
    }
    const parsed = workbookType === "csv"
      ? await parseCsvWorkbook(rootPath, file.path, { maxRows: CSV_PROFILE_MAX_ROWS })
      : await parseXlsxWorkbook(rootPath, file.path, { maxRows: CSV_PROFILE_MAX_ROWS });
    caveats.push(...parsed.flatMap((sheet) => sheet.truncated ? [`${file.path}:${sheet.name} profile was truncated.`] : []));
    const sheets = parsed.slice(0, PROFILE_WORKSHEET_LIMIT).map(worksheetProfile);
    if (parsed.length > sheets.length) caveats.push(`Workbook has ${parsed.length} sheets; profile includes first ${sheets.length}.`);
    const signature = spreadsheetSignature(file.path, sheets);
    return {
      path: file.path,
      extension,
      bytes: file.bytes,
      workbookType,
      sheetCount: parsed.length,
      sheets,
      signature,
      truncated: caveats.length > 0,
      caveats,
    };
  } catch (error) {
    return errorProfile(file, workbookType, publicErrorMessage(error), ["Spreadsheet could not be profiled; file identity is still included."]);
  }
}

async function extractSpreadsheetFile(
  rootPath: string,
  file: SpreadsheetFileEntry,
  options: { readonly maxRowsPerSheet: number; readonly maxTotalCells: number },
): Promise<SpreadsheetExtractionFile> {
  const extension = extname(file.path).toLowerCase();
  const workbookType = spreadsheetWorkbookType(extension);
  const caveats: string[] = [];
  try {
    const parsed = workbookType === "csv"
      ? await parseCsvWorkbook(rootPath, file.path, { maxRows: options.maxRowsPerSheet })
      : await parseXlsxWorkbook(rootPath, file.path, { maxRows: options.maxRowsPerSheet });
    let usedCells = 0;
    let truncated = false;
    const sheets: SpreadsheetExtractionSheet[] = [];
    for (const worksheet of parsed) {
      if (usedCells >= options.maxTotalCells) {
        truncated = true;
        break;
      }
      const profile = worksheetProfile(worksheet);
      const header = profile.candidateHeaders[0];
      const rows: SpreadsheetRow[] = [];
      let sheetTruncated = worksheet.truncated;
      for (const row of worksheet.rows) {
        if (rows.length >= options.maxRowsPerSheet || usedCells + row.cells.length > options.maxTotalCells) {
          sheetTruncated = true;
          truncated = true;
          break;
        }
        rows.push(row);
        usedCells += row.cells.length;
      }
      const columns = extractionColumns(rows, header);
      const records = extractionRecords(rows, header, columns);
      sheets.push({
        name: worksheet.name,
        index: worksheet.index,
        sourceRange: profile.observedRange ?? worksheet.declaredRange,
        ...(header === undefined ? {} : { header }),
        columns,
        rows,
        records,
        rowCount: rows.length,
        recordCount: records.length,
        cellCount: rows.reduce((sum, row) => sum + row.cells.length, 0),
        truncated: sheetTruncated,
      });
      if (sheetTruncated) caveats.push(`${file.path}:${worksheet.name} extraction was truncated.`);
    }
    const material = JSON.stringify({ path: file.path, sheets });
    return {
      path: file.path,
      extension,
      bytes: file.bytes,
      workbookType,
      sheets,
      sha256: createHash("sha256").update(material).digest("hex"),
      truncated,
      caveats,
    };
  } catch (error) {
    return {
      path: file.path,
      extension,
      bytes: file.bytes,
      workbookType,
      sheets: [],
      sha256: createHash("sha256").update(file.path).digest("hex"),
      truncated: false,
      caveats: ["Spreadsheet could not be extracted; file identity is still included."],
      error: publicErrorMessage(error),
    };
  }
}

async function parseXlsxWorkbook(rootPath: string, path: string, options: { readonly maxRows: number }): Promise<ParsedWorksheet[]> {
  const zip = await JSZip.loadAsync(await fs.readFile(resolve(rootPath, path)));
  const workbookXml = await zipText(zip, "xl/workbook.xml");
  const relsXml = await zipText(zip, "xl/_rels/workbook.xml.rels").catch(() => "");
  const rels = parseWorkbookRelationships(relsXml);
  const sharedStrings = await parseSharedStrings(zip);
  const sheets = parseWorkbookSheets(workbookXml, rels);
  const parsed: ParsedWorksheet[] = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    const xml = await zipText(zip, sheet.path);
    parsed.push(parseWorksheetXml(sheet.name, index, xml, sharedStrings, options.maxRows));
  }
  return parsed;
}

async function parseCsvWorkbook(rootPath: string, path: string, options: { readonly maxRows: number }): Promise<ParsedWorksheet[]> {
  const content = await fs.readFile(resolve(rootPath, path), "utf8");
  const rows = parseCsvRows(content, options.maxRows + 1);
  const truncated = rows.length > options.maxRows;
  const selectedRows = truncated ? rows.slice(0, options.maxRows) : rows;
  return [{
    name: "CSV",
    index: 0,
    ...csvObservedRange(selectedRows),
    mergedCellRefs: [],
    rows: selectedRows.map((row, rowIndex) => ({
      row: rowIndex + 1,
      cells: row.flatMap((value, columnIndex) => {
        if (value === "") return [];
        const kind = csvValueKind(value);
        return [{
          address: `${columnName(columnIndex + 1)}${rowIndex + 1}`,
          row: rowIndex + 1,
          column: columnIndex + 1,
          value: kind === "number" ? Number(value) : value,
          valueKind: kind,
        }];
      }),
    })).filter((row) => row.cells.length > 0),
    truncated,
  }];
}

async function zipText(zip: ZipArchive, path: string): Promise<string> {
  const file = zip.file(path);
  if (file === null) throw new Error(`Missing ${path}`);
  return await file.async("string");
}

async function parseSharedStrings(zip: ZipArchive): Promise<string[]> {
  const file = zip.file("xl/sharedStrings.xml");
  if (file === null) return [];
  const xml = await file.async("string");
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((match) =>
    decodeXml(stripXmlTags([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map((textMatch) => textMatch[1]).join("")))
  );
}

function parseWorkbookRelationships(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const attrs = parseXmlAttributes(match[1]);
    const id = attrs.get("Id");
    const target = attrs.get("Target");
    if (id === undefined || target === undefined) continue;
    rels.set(id, normalizeWorkbookTarget(target));
  }
  return rels;
}

function parseWorkbookSheets(xml: string, rels: ReadonlyMap<string, string>): WorkbookSheetEntry[] {
  const sheets: WorkbookSheetEntry[] = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?>/gu)) {
    const attrs = parseXmlAttributes(match[1]);
    const name = attrs.get("name");
    const relId = attrs.get("r:id");
    if (name === undefined) continue;
    const path = relId === undefined ? undefined : rels.get(relId);
    sheets.push({ name: decodeXml(name), path: path ?? `xl/worksheets/sheet${sheets.length + 1}.xml` });
  }
  return sheets;
}

function parseWorksheetXml(
  name: string,
  index: number,
  xml: string,
  sharedStrings: readonly string[],
  maxRows: number,
): ParsedWorksheet {
  const dimension = /<dimension\b[^>]*\bref="([^"]+)"/u.exec(xml)?.[1];
  const mergedCellRefs = [...xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/gu)]
    .map((match) => match[1]);
  const rows: SpreadsheetRow[] = [];
  let truncated = false;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gu)) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const rowAttrs = parseXmlAttributes(rowMatch[1]);
    const rowNumber = Number(rowAttrs.get("r") ?? rows.length + 1);
    const cells = [...rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)]
      .map((cellMatch) => parseXlsxCell(cellMatch[1], cellMatch[2], sharedStrings, rowNumber))
      .filter((cell) => cell.valueKind !== "blank");
    if (cells.length > 0) rows.push({ row: rowNumber, cells });
  }
  return {
    name,
    index,
    ...(dimension === undefined ? {} : { declaredRange: dimension }),
    mergedCellRefs,
    rows,
    truncated,
  };
}

function parseXlsxCell(attrsText: string, body: string, sharedStrings: readonly string[], fallbackRow: number): SpreadsheetCell {
  const attrs = parseXmlAttributes(attrsText);
  const address = attrs.get("r") ?? `A${fallbackRow}`;
  const location = parseCellAddress(address) ?? { row: fallbackRow, column: 1 };
  const type = attrs.get("t");
  const formula = matchXmlText(body, "f");
  const rawValue = matchXmlText(body, "v");
  const inline = matchXmlText(body, "t");
  if (formula !== undefined) {
    return {
      address,
      row: location.row,
      column: location.column,
      value: rawValue === undefined ? undefined : decodeXml(rawValue),
      valueKind: "formula",
      formula: decodeXml(formula),
    };
  }
  if (type === "s") {
    const value = sharedStrings[Number(rawValue ?? -1)];
    return cellWithValue(address, location.row, location.column, value ?? "", "text");
  }
  if (type === "inlineStr" || type === "str") {
    return cellWithValue(address, location.row, location.column, decodeXml(inline ?? rawValue ?? ""), "text");
  }
  if (type === "b") {
    return cellWithValue(address, location.row, location.column, rawValue === "1", "boolean");
  }
  if (rawValue === undefined || rawValue === "") {
    return { address, row: location.row, column: location.column, valueKind: "blank" };
  }
  const decoded = decodeXml(rawValue);
  return NUMBER_PATTERN.test(decoded)
    ? cellWithValue(address, location.row, location.column, Number(decoded), "number")
    : cellWithValue(address, location.row, location.column, decoded, "text");
}

function worksheetProfile(worksheet: ParsedWorksheet): SpreadsheetWorksheetProfile {
  const cells = worksheet.rows.flatMap((row) => row.cells);
  const maxRow = Math.max(0, ...cells.map((cell) => cell.row));
  const maxColumn = Math.max(0, ...cells.map((cell) => cell.column));
  const minRow = Math.min(...cells.map((cell) => cell.row));
  const minColumn = Math.min(...cells.map((cell) => cell.column));
  const valueKinds = countBy(cells.map((cell) => cell.valueKind));
  return {
    name: worksheet.name,
    index: worksheet.index,
    ...(worksheet.declaredRange === undefined ? {} : { declaredRange: worksheet.declaredRange }),
    ...(cells.length === 0 ? {} : { observedRange: rangeRef(minRow, minColumn, maxRow, maxColumn) }),
    rowCount: new Set(cells.map((cell) => cell.row)).size,
    columnCount: maxColumn,
    nonEmptyCellCount: cells.length,
    mergedCellCount: worksheet.mergedCellRefs.length,
    mergedCellSamples: worksheet.mergedCellRefs.slice(0, PROFILE_MERGE_SAMPLE_LIMIT),
    formulaCellCount: valueKinds.formula ?? 0,
    valueKinds,
    candidateHeaders: candidateHeaders(worksheet.rows),
  };
}

function candidateHeaders(rows: readonly SpreadsheetRow[]): SpreadsheetHeaderCandidate[] {
  const headers: SpreadsheetHeaderCandidate[] = [];
  for (const row of rows) {
    if (row.row > PROFILE_HEADER_SCAN_ROWS) continue;
    const textCells = row.cells.filter((cell) => cell.valueKind === "text" && String(cell.value ?? "").trim().length > 0);
    if (textCells.length < 2) continue;
    headers.push({
      row: row.row,
      range: rangeRef(row.row, Math.min(...textCells.map((cell) => cell.column)), row.row, Math.max(...textCells.map((cell) => cell.column))),
      nonEmptyCellCount: row.cells.length,
      values: textCells.map((cell) => String(cell.value)).slice(0, PROFILE_HEADER_VALUE_LIMIT),
    });
    if (headers.length >= 5) break;
  }
  return headers;
}

function extractionColumns(rows: readonly SpreadsheetRow[], header: SpreadsheetHeaderCandidate | undefined): SpreadsheetExtractionColumn[] {
  const headerRow = header === undefined ? undefined : rows.find((row) => row.row === header.row);
  const headerCellsByColumn = new Map((headerRow?.cells ?? []).map((cell) => [cell.column, cell]));
  const allColumns = [...new Set(rows.flatMap((row) => row.cells.map((cell) => cell.column)))].sort((a, b) => a - b);
  const usedNames = new Map<string, number>();
  return allColumns.map((column) => {
    const headerCell = headerCellsByColumn.get(column);
    const rawName = headerCell === undefined ? "" : String(headerCell.value ?? "").trim();
    const name = uniqueColumnName(rawName.length === 0 ? columnName(column) : rawName, usedNames);
    const bodyCells = rows
      .filter((row) => row.row !== header?.row)
      .flatMap((row) => row.cells.filter((cell) => cell.column === column));
    return {
      index: column,
      address: columnName(column),
      name,
      ...(headerCell === undefined ? {} : { sourceAddress: headerCell.address }),
      nonEmptyCellCount: bodyCells.length,
      valueKinds: countBy(bodyCells.map((cell) => cell.valueKind)),
    };
  });
}

function extractionRecords(
  rows: readonly SpreadsheetRow[],
  header: SpreadsheetHeaderCandidate | undefined,
  columns: readonly SpreadsheetExtractionColumn[],
): SpreadsheetExtractionRecord[] {
  const columnNames = new Map(columns.map((column) => [column.index, column.name]));
  return rows
    .filter((row) => row.row !== header?.row)
    .map((row) => {
      const values: Record<string, string | number | boolean> = {};
      for (const cell of row.cells) {
        const name = columnNames.get(cell.column);
        if (name === undefined || cell.value === undefined) continue;
        values[name] = cell.value;
      }
      const columnsInRow = row.cells.map((cell) => cell.column);
      return {
        row: row.row,
        sourceRange: rangeRef(row.row, Math.min(...columnsInRow), row.row, Math.max(...columnsInRow)),
        values,
        cellCount: row.cells.length,
      };
    });
}

function uniqueColumnName(base: string, usedNames: Map<string, number>): string {
  const current = usedNames.get(base) ?? 0;
  usedNames.set(base, current + 1);
  return current === 0 ? base : `${base}_${current + 1}`;
}

function csvObservedRange(rows: readonly string[][]): { readonly observedRange?: string } {
  const maxColumn = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length === 0 || maxColumn === 0) return {};
  return { observedRange: rangeRef(1, 1, rows.length, maxColumn) };
}

function spreadsheetSignatureGroups(profiles: readonly SpreadsheetFileProfile[]): SpreadsheetSignatureGroup[] {
  const groups = new Map<string, { count: number; samplePaths: string[]; sheetNames: string[]; sheetShapes: string[] }>();
  for (const profile of profiles) {
    const current = groups.get(profile.signature) ?? { count: 0, samplePaths: [], sheetNames: [], sheetShapes: [] };
    current.count += 1;
    if (current.samplePaths.length < 8) current.samplePaths.push(profile.path);
    if (current.sheetNames.length === 0) current.sheetNames.push(...profile.sheets.map((sheet) => sheet.name));
    if (current.sheetShapes.length === 0) current.sheetShapes.push(...profile.sheets.map((sheet) => `${sheet.rowCount}x${sheet.columnCount}`));
    groups.set(profile.signature, current);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([signature, group]) => ({ signature, ...group }));
}

function spreadsheetSignature(path: string, sheets: readonly SpreadsheetWorksheetProfile[]): string {
  const material = JSON.stringify({
    extension: extname(path).toLowerCase(),
    sheets: sheets.map((sheet) => ({
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      headers: sheet.candidateHeaders[0]?.values ?? [],
    })),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function spreadsheetWorkbookType(extension: string): "xlsx" | "xlsm" | "csv" {
  if (extension === ".csv") return "csv";
  if (extension === ".xlsm") return "xlsm";
  return "xlsx";
}

function errorProfile(file: SpreadsheetFileEntry, workbookType: "xlsx" | "xlsm" | "csv", error: string, caveats: readonly string[]): SpreadsheetFileProfile {
  return {
    path: file.path,
    extension: extname(file.path).toLowerCase(),
    bytes: file.bytes,
    workbookType,
    sheetCount: 0,
    sheets: [],
    signature: createHash("sha256").update(`${file.path}:${file.bytes}:${error}`).digest("hex").slice(0, 16),
    truncated: false,
    caveats,
    error,
  };
}

function parseCsvRows(content: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === "\"" && content[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) return rows;
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu;

function csvValueKind(value: string): "text" | "number" {
  return NUMBER_PATTERN.test(value.trim()) ? "number" : "text";
}

function cellWithValue(
  address: string,
  row: number,
  column: number,
  value: string | number | boolean,
  valueKind: SpreadsheetCell["valueKind"],
): SpreadsheetCell {
  return { address, row, column, value, valueKind };
}

function parseXmlAttributes(value: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/gu)) {
    attrs.set(match[1], decodeXml(match[2]));
  }
  return attrs;
}

function matchXmlText(body: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "u").exec(body);
  return match?.[1];
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function normalizeWorkbookTarget(target: string): string {
  const normalized = target.replace(/\\/gu, "/").replace(/^\/+/u, "");
  return normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
}

function parseCellAddress(address: string): { readonly row: number; readonly column: number } | undefined {
  const match = /^([A-Z]+)(\d+)$/iu.exec(address);
  if (match === null) return undefined;
  return { column: columnNumber(match[1].toUpperCase()), row: Number(match[2]) };
}

function columnNumber(value: string): number {
  let output = 0;
  for (const char of value) output = output * 26 + char.charCodeAt(0) - 64;
  return output;
}

function columnName(value: number): string {
  let output = "";
  let current = value;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    current = Math.floor((current - 1) / 26);
  }
  return output || "A";
}

function rangeRef(minRow: number, minColumn: number, maxRow: number, maxColumn: number): string {
  if (minRow <= 0 || minColumn <= 0 || maxRow <= 0 || maxColumn <= 0) return "";
  return `${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}`;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
