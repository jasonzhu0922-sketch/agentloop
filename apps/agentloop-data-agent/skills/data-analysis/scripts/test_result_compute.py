import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import result_compute


class ResultComputeTests(unittest.TestCase):
    def test_group_summary_is_bounded_and_keeps_input_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'query.json'
            source.write_text(json.dumps({'dataset': {'rows': [
                {'region': '山东', 'price': 10},
                {'region': '山东', 'price': 20},
                {'region': '江苏', 'price': 30},
            ]}}, ensure_ascii=False), encoding='utf-8')
            prior = os.environ.get('AGENTLOOP_WORKSPACE_ROOT')
            os.environ['AGENTLOOP_WORKSPACE_ROOT'] = directory
            try:
                result = result_compute.compute({
                    'input': '@workspace/query.json',
                    'operation': 'group_summary',
                    'group_by': ['region'],
                    'aggregations': {
                        'count': {'op': 'count'},
                        'avg': {'op': 'avg', 'field': 'price'},
                        'median': {'op': 'median', 'field': 'price'},
                        'distinct_regions': {'op': 'distinct_count', 'field': 'region'},
                    },
                    'limit': 10,
                })
            finally:
                if prior is None:
                    os.environ.pop('AGENTLOOP_WORKSPACE_ROOT', None)
                else:
                    os.environ['AGENTLOOP_WORKSPACE_ROOT'] = prior
            self.assertEqual(result['dataset']['row_count'], 2)
            self.assertEqual(result['dataset']['rows'][0]['avg'], 15.0)
            self.assertEqual(result['dataset']['rows'][0]['distinct_regions'], 1)
            self.assertEqual(result['input']['row_count'], 3)
            self.assertEqual(len(result['input']['sha256']), 64)

    def test_input_must_stay_in_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = os.environ.get('AGENTLOOP_WORKSPACE_ROOT')
            os.environ['AGENTLOOP_WORKSPACE_ROOT'] = directory
            try:
                with self.assertRaises(result_compute.ComputeError):
                    result_compute.workspace_path('/tmp/outside.json', 'input')
            finally:
                if prior is None:
                    os.environ.pop('AGENTLOOP_WORKSPACE_ROOT', None)
                else:
                    os.environ['AGENTLOOP_WORKSPACE_ROOT'] = prior

    def test_invalid_fields_and_output_collisions_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'query.json'
            source.write_text(json.dumps({'dataset': {'columns': ['region', 'value'],
                'rows': [{'region': '山东', 'value': 1}]}}), encoding='utf-8')
            prior = os.environ.get('AGENTLOOP_WORKSPACE_ROOT')
            os.environ['AGENTLOOP_WORKSPACE_ROOT'] = directory
            try:
                base = {'input': '@workspace/query.json', 'operation': 'group_summary',
                        'group_by': ['region'], 'aggregations': {'total': {'op': 'sum', 'field': 'value'}}}
                for request in ({**base, 'group_by': ['missing']},
                                {**base, 'aggregations': {'region': {'op': 'count'}}},
                                {**base, 'sort': [{'field': 'missing'}]}):
                    with self.assertRaises(result_compute.ComputeError):
                        result_compute.compute(request)
            finally:
                if prior is None:
                    os.environ.pop('AGENTLOOP_WORKSPACE_ROOT', None)
                else:
                    os.environ['AGENTLOOP_WORKSPACE_ROOT'] = prior


if __name__ == '__main__':
    unittest.main()
