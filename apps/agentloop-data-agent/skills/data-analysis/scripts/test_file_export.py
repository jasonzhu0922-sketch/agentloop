import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import file_export
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation


class FileExportTest(unittest.TestCase):
    def spec(self):
        return {
            'schema': 'data-agent.file-export/v1',
            'title': '经营报告',
            'summary': ['数据已经过查询结果核对'],
            'tables': [{
                'name': '指标',
                'columns': ['名称', '数值'],
                'rows': [['收入', 123.4], ['危险文本', '=2+2']],
            }],
        }

    def test_all_supported_formats_are_created(self):
        signatures = {
            'xlsx': b'PK', 'docx': b'PK', 'pptx': b'PK', 'pdf': b'%PDF',
            'html': b'<!doctype html>', 'markdown': '# 经营报告'.encode(),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf_root = Path(__file__).resolve().parents[5] / 'packages' / 'agentloop-skills' / 'skills' / 'pdf'
            prior_pdf_root = os.environ.get('AGENTLOOP_SKILL_ROOT_PDF')
            os.environ['AGENTLOOP_SKILL_ROOT_PDF'] = str(pdf_root)
            self.addCleanup(lambda: os.environ.pop('AGENTLOOP_SKILL_ROOT_PDF', None) if prior_pdf_root is None
                            else os.environ.__setitem__('AGENTLOOP_SKILL_ROOT_PDF', prior_pdf_root))
            spec_path = root / 'spec.json'
            spec_path.write_text(json.dumps(self.spec(), ensure_ascii=False), encoding='utf-8')
            for format_name in ('xlsx', 'csv', 'docx', 'pdf', 'pptx', 'html', 'markdown'):
                extension = 'md' if format_name == 'markdown' else format_name
                output = root / ('output.' + extension)
                self.assertEqual(file_export.main_for_test(['build', '--format', format_name, '--spec', str(spec_path), '--output', str(output)]), 0)
                self.assertTrue(output.is_file(), format_name)
                self.assertGreater(output.stat().st_size, 20, format_name)
                if format_name in signatures:
                    self.assertTrue(output.read_bytes().startswith(signatures[format_name]), format_name)
            self.assertIn("'=2+2", (root / 'output.csv').read_text(encoding='utf-8-sig'))
            workbook = load_workbook(root / 'output.xlsx', data_only=False)
            self.assertEqual(workbook['指标']['A2'].value, '收入')
            self.assertEqual(workbook['指标']['B3'].value, "'=2+2")
            document = Document(root / 'output.docx')
            self.assertEqual(document.paragraphs[0].text, '经营报告')
            self.assertEqual(document.tables[0].cell(1, 0).text, '收入')
            presentation = Presentation(root / 'output.pptx')
            self.assertGreaterEqual(len(presentation.slides), 2)
            html_text = (root / 'output.html').read_text(encoding='utf-8')
            self.assertIn('data-filter="table-1"', html_text)
            self.assertIn('addEventListener', html_text)

    def test_rejects_rows_that_do_not_match_columns(self):
        spec = self.spec()
        spec['tables'][0]['rows'] = [['missing']]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'spec.json'
            path.write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'row width'):
                file_export.load_spec(path)

    def test_presentation_export_is_bounded(self):
        spec = self.spec()
        spec['tables'][0]['rows'] = [[f'row {index}', index] for index in range(501)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, output = root / 'spec.json', root / 'output.pptx'
            path.write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'PPTX export supports'):
                file_export.main_for_test(['build', '--format', 'pptx', '--spec', str(path), '--output', str(output)])


if __name__ == '__main__':
    unittest.main()
