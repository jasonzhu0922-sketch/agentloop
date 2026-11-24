"""对 typed intent 中保留的题面做保守覆盖检查，不承担自然语言转 SQL。

这里的 question 仍由模型提交，不是 Run 持有的用户原题。因此即使某个月份
与计划吻合，也只能说明草稿内部这一项没有冲突；不能据此宣称主体、指标、
筛选和最终答案均已覆盖原题。Run 原题的独立月份核对由宿主策略完成。
"""
import re
from datetime import date

MONTH = re.compile(r'(?<!\d)(20\d{2})\s*年\s*(1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\s*月')
CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
      '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12}


def coverage(intent):
    # 只提取字面明确的年月。相对时间、多期间比较及业务名词都需要另行查证；
    # 候选指标和筛选没有原文 span 时保持 unproven，不从模型草稿反推为已选定。
    question = intent['question']
    period = intent.get('time_range')
    rows = []
    for match in MONTH.finditer(question):
        month = int(match[2]) if match[2].isdigit() else CN[match[2]]
        start = date(int(match[1]), month, 1).isoformat()
        status = 'unresolved' if period is None else (
            'matched' if period['start'] <= start < period['end'] else 'conflict')
        rows.append({'kind': 'period', 'span': match[0], 'start': match.start(),
                     'end': match.end(), 'canonical_month': start, 'status': status,
                     'evidence': 'literal calendar month in model-supplied question'})
    for ref in intent.get('metric_refs', []):
        if isinstance(ref, dict) and isinstance(ref.get('metric_id'), str):
            rows.append({'kind': 'metric_candidate', 'span': None,
                         'candidate': ref['metric_id'], 'status': 'unproven',
                         'evidence': 'typed metric reference; compare with original Run and current catalog'})
    for binding in intent.get('filters', []):
        if isinstance(binding, dict):
            rows.append({'kind': 'filter_candidate', 'span': None,
                         'candidate': binding, 'status': 'unproven',
                         'evidence': 'typed filter; compare with original Run and current catalog'})
    for scope in intent.get('scopes', []):
        if isinstance(scope, dict):
            rows.append({'kind': 'scope_candidate', 'span': None,
                         'candidate': scope.get('id'), 'status': 'unproven',
                         'evidence': 'typed scope; compare with original Run and entity lookup'})
    return {'schema': 'nl2sql.question-coverage/v1', 'status': 'unproven',
            'question_authority': 'model_supplied', 'conditions': rows,
            'required_outputs': [], 'result_shape': 'unproven',
            'answer_labels': 'agent_review_required'}


def check_coverage(intent):
    return coverage(intent)
