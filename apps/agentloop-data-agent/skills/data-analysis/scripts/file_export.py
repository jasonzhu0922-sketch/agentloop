#!/usr/bin/env python3
"""Build bounded business deliverables from one validated JSON specification."""

import argparse
import csv
import hashlib
import html
import json
import os
from pathlib import Path

SCHEMA = 'data-agent.file-export/v1'
FORMATS = {'xlsx', 'csv', 'docx', 'pdf', 'pptx', 'html', 'markdown'}
MAX_TABLES = 20
MAX_COLUMNS = 100
MAX_ROWS = 20000
MAX_TEXT = 2_000_000


def check(condition, message):
    if not condition:
        raise ValueError(message)


def text(value, maximum=32767):
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    value = str(value)
    check(len(value) <= maximum, 'cell text is too long')
    return value


def spreadsheet_value(value):
    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
        return "'" + value
    return value


def load_spec(path):
    spec = json.loads(Path(path).read_text(encoding='utf-8'))
    check(isinstance(spec, dict) and spec.get('schema') == SCHEMA, 'invalid file export schema')
    check(isinstance(spec.get('title'), str) and spec['title'].strip(), 'title is required')
    summary = spec.get('summary', [])
    check(isinstance(summary, list) and all(isinstance(item, str) for item in summary), 'summary must be strings')
    tables = spec.get('tables', [])
    check(isinstance(tables, list) and len(tables) <= MAX_TABLES, 'too many tables')
    row_count = 0
    for index, table in enumerate(tables):
        check(isinstance(table, dict), f'tables[{index}] must be an object')
        columns, rows = table.get('columns'), table.get('rows')
        check(isinstance(columns, list) and 0 < len(columns) <= MAX_COLUMNS and all(isinstance(item, str) and item for item in columns), f'tables[{index}] columns are invalid')
        check(isinstance(rows, list), f'tables[{index}] rows must be an array')
        for row in rows:
            check(isinstance(row, list) and len(row) == len(columns), f'tables[{index}] row width differs from columns')
            for value in row:
                text(value)
        row_count += len(rows)
    check(row_count <= MAX_ROWS, 'too many rows')
    check(len(json.dumps(spec, ensure_ascii=False)) <= MAX_TEXT, 'file export specification is too large')
    return spec


def safe_sheet_name(value, used):
    base = ''.join('_' if char in '[]:*?/\\' else char for char in text(value, 100)).strip()[:31] or 'Data'
    name, counter = base, 2
    while name in used:
        suffix = f' {counter}'
        name, counter = base[:31-len(suffix)] + suffix, counter + 1
    used.add(name)
    return name


def build_xlsx(spec, output):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    workbook = Workbook()
    workbook.remove(workbook.active)
    used = set()
    if spec.get('summary') or not spec.get('tables'):
        sheet = workbook.create_sheet(safe_sheet_name('摘要', used))
        sheet.append([spec['title']])
        sheet['A1'].font = Font(bold=True, size=16)
        for item in spec.get('summary', []):
            sheet.append([item])
        sheet.column_dimensions['A'].width = 80
    for table_index, table in enumerate(spec.get('tables', []), 1):
        sheet = workbook.create_sheet(safe_sheet_name(table.get('name') or f'数据{table_index}', used))
        sheet.append(table['columns'])
        for row in table['rows']:
            sheet.append([spreadsheet_value(value) for value in row])
        for cell in sheet[1]:
            cell.font = Font(bold=True, color='FFFFFF')
            cell.fill = PatternFill('solid', fgColor='1D4F3A')
            cell.alignment = Alignment(horizontal='center')
        sheet.freeze_panes = 'A2'
        sheet.auto_filter.ref = sheet.dimensions
        for column, values in enumerate(zip(table['columns'], *table['rows']), 1):
            width = min(50, max(10, max(len(text(value, 200)) for value in values) + 2))
            sheet.column_dimensions[get_column_letter(column)].width = width
    if not workbook.worksheets:
        workbook.create_sheet('摘要')
    workbook.save(output)


def build_csv(spec, output):
    check(len(spec.get('tables', [])) == 1, 'CSV export requires exactly one table')
    table = spec['tables'][0]
    with open(output, 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(table['columns'])
        writer.writerows([[spreadsheet_value(value) for value in row] for row in table['rows']])


def build_docx(spec, output):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    document = Document()
    title = document.add_heading(spec['title'], 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if spec.get('subtitle'):
        paragraph = document.add_paragraph(text(spec['subtitle']))
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for item in spec.get('summary', []):
        document.add_paragraph(item, style='List Bullet')
    for index, table in enumerate(spec.get('tables', []), 1):
        document.add_heading(text(table.get('name') or f'数据表 {index}'), level=1)
        grid = document.add_table(rows=1, cols=len(table['columns']))
        grid.style = 'Table Grid'
        for cell, value in zip(grid.rows[0].cells, table['columns']):
            cell.text = text(value)
        for row in table['rows']:
            cells = grid.add_row().cells
            for cell, value in zip(cells, row):
                cell.text = text(value)
    document.save(output)


def pdf_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    root = os.environ.get('AGENTLOOP_SKILL_ROOT_PDF')
    path = Path(root, 'assets', 'fonts', 'NotoSansSC.ttf') if root else None
    if path and path.is_file():
        pdfmetrics.registerFont(TTFont('NotoSansSC', str(path)))
        return 'NotoSansSC'
    return 'Helvetica'


def build_pdf(spec, output):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, TableStyle, PageBreak
    font = pdf_font()
    widest = max((len(table['columns']) for table in spec.get('tables', [])), default=1)
    page_size = landscape(A4) if widest > 6 else A4
    styles = getSampleStyleSheet()
    normal = ParagraphStyle('CJK', parent=styles['BodyText'], fontName=font, fontSize=9, leading=13)
    heading = ParagraphStyle('CJKHeading', parent=styles['Heading1'], fontName=font, fontSize=16, leading=22)
    story = [Paragraph(html.escape(spec['title']), heading), Spacer(1, 5 * mm)]
    for item in spec.get('summary', []):
        story.extend([Paragraph('• ' + html.escape(item), normal), Spacer(1, 1.5 * mm)])
    for index, table in enumerate(spec.get('tables', []), 1):
        if index > 1 or spec.get('summary'):
            story.append(PageBreak())
        story.append(Paragraph(html.escape(text(table.get('name') or f'数据表 {index}')), heading))
        data = [[Paragraph(html.escape(text(value)), normal) for value in table['columns']]]
        data += [[Paragraph(html.escape(text(value)), normal) for value in row] for row in table['rows']]
        grid = LongTable(data, repeatRows=1)
        grid.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1D4F3A')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white), ('FONTNAME', (0, 0), (-1, -1), font),
            ('FONTSIZE', (0, 0), (-1, -1), 7), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#B8C5BC')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F4F7F4')])]))
        story.append(grid)
    SimpleDocTemplate(output, pagesize=page_size, rightMargin=12*mm, leftMargin=12*mm, topMargin=12*mm, bottomMargin=12*mm).build(story)


def build_pptx(spec, output):
    from pptx import Presentation
    from pptx.util import Inches, Pt
    presentation = Presentation()
    presentation.slide_width, presentation.slide_height = Inches(13.333), Inches(7.5)
    slide = presentation.slides.add_slide(presentation.slide_layouts[0])
    slide.shapes.title.text = spec['title']
    slide.placeholders[1].text = text(spec.get('subtitle') or '\n'.join(spec.get('summary', [])[:4]))
    for table_index, table in enumerate(spec.get('tables', []), 1):
        chunks = [table['rows'][offset:offset+14] for offset in range(0, len(table['rows']), 14)] or [[]]
        for chunk_index, rows in enumerate(chunks, 1):
            slide = presentation.slides.add_slide(presentation.slide_layouts[5])
            slide.shapes.title.text = text(table.get('name') or f'数据表 {table_index}') + (f'（{chunk_index}/{len(chunks)}）' if len(chunks) > 1 else '')
            shape = slide.shapes.add_table(len(rows)+1, len(table['columns']), Inches(.45), Inches(1.3), Inches(12.4), Inches(5.7))
            grid = shape.table
            for column, value in enumerate(table['columns']):
                grid.cell(0, column).text = text(value)
            for row_index, row in enumerate(rows, 1):
                for column, value in enumerate(row):
                    grid.cell(row_index, column).text = text(value)
            for row in grid.rows:
                for cell in row.cells:
                    for paragraph in cell.text_frame.paragraphs:
                        paragraph.font.size = Pt(10)
    presentation.save(output)


def build_html(spec, output):
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>',
        html.escape(spec['title']), '</title><style>body{font:14px/1.6 system-ui;margin:32px;color:#17251d}main{max-width:1200px;margin:auto}h1{color:#1d4f3a}table{border-collapse:collapse;width:100%;margin:16px 0 32px}th,td{border:1px solid #ccd8cf;padding:8px 10px;text-align:left}th{background:#1d4f3a;color:white}tr:nth-child(even){background:#f5f8f5}.scroll{overflow:auto}</style><main><h1>',
        html.escape(spec['title']), '</h1>']
    if spec.get('summary'):
        parts.append('<ul>' + ''.join(f'<li>{html.escape(item)}</li>' for item in spec['summary']) + '</ul>')
    for index, table in enumerate(spec.get('tables', []), 1):
        table_id = f'table-{index}'
        parts.extend(['<h2>', html.escape(text(table.get('name') or f'数据表 {index}')),
            f'</h2><label>筛选当前表 <input type="search" data-filter="{table_id}" placeholder="输入关键字"></label><div class="scroll"><table id="{table_id}"><thead><tr>',
            ''.join(f'<th>{html.escape(value)}</th>' for value in table['columns']), '</tr></thead><tbody>'])
        for row in table['rows']:
            parts.append('<tr>' + ''.join(f'<td>{html.escape(text(value))}</td>' for value in row) + '</tr>')
        parts.append('</tbody></table></div>')
    parts.append("</main><script>document.querySelectorAll('[data-filter]').forEach(function(input){input.addEventListener('input',function(){var q=input.value.toLowerCase();document.querySelectorAll('#'+input.dataset.filter+' tbody tr').forEach(function(row){row.hidden=!row.textContent.toLowerCase().includes(q);});});});</script></html>")
    Path(output).write_text(''.join(parts), encoding='utf-8')


def build_markdown(spec, output):
    markdown = lambda value: text(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    lines = [f"# {markdown(spec['title'])}", '']
    lines.extend(f'- {markdown(item)}' for item in spec.get('summary', []))
    if spec.get('summary'):
        lines.append('')
    for index, table in enumerate(spec.get('tables', []), 1):
        lines.extend([f"## {markdown(table.get('name') or f'数据表 {index}')}", '',
            '| ' + ' | '.join(markdown(value).replace('|', '\\|') for value in table['columns']) + ' |',
            '| ' + ' | '.join('---' for _ in table['columns']) + ' |'])
        for row in table['rows']:
            lines.append('| ' + ' | '.join(markdown(value).replace('\n', '<br>').replace('|', '\\|') for value in row) + ' |')
        lines.append('')
    Path(output).write_text('\n'.join(lines), encoding='utf-8')


def main_for_test(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['build'])
    parser.add_argument('--format', required=True, choices=sorted(FORMATS))
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    spec, output = load_spec(args.spec), Path(args.output)
    rows = sum(len(table['rows']) for table in spec.get('tables', []))
    columns = max((len(table['columns']) for table in spec.get('tables', [])), default=0)
    if args.format == 'pptx':
        check(rows <= 500 and columns <= 12, 'PPTX export supports at most 500 rows and 12 columns')
    elif args.format in {'docx', 'pdf'}:
        check(rows <= 5000 and columns <= 30, args.format.upper() + ' export supports at most 5000 rows and 30 columns')
    expected = '.md' if args.format == 'markdown' else '.' + args.format
    check(output.suffix.lower() == expected, f'output extension must be {expected}')
    output.parent.mkdir(parents=True, exist_ok=True)
    globals()['build_' + args.format](spec, str(output))
    payload = output.read_bytes()
    print(json.dumps({'schema': 'data-agent.file-export-result/v1', 'format': args.format,
        'output': str(output.resolve()), 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}, ensure_ascii=False))
    return 0


def main():
    return main_for_test()


if __name__ == '__main__':
    main()
