function Invoke-ReportQualityCheck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReportDir,

        [Parameter(Mandatory = $false)]
        [string]$ReportFile,

        [Parameter(Mandatory = $false)]
        [string]$OutputDir = (Join-Path $ReportDir 'qc-reports'),

        [Parameter(Mandatory = $false)]
        [ValidateSet('format','content','all')]
        [string]$CheckType = 'all'
    )

    # Ensure output directory exists
    if (-not (Test-Path $OutputDir)) {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    }

    # Resolve files
    $files = if ($ReportFile) {
        $p = Join-Path $ReportDir $ReportFile
        if (Test-Path $p) { @(Get-Item $p) } else { Write-Warning "File not found: $p"; @() }
    } else {
        @(Get-ChildItem -Path $ReportDir -Filter '*.md' -ErrorAction SilentlyContinue)
    }

    if ($files.Count -eq 0) {
        Write-Host "No markdown reports found in $ReportDir"
        return
    }

    $results = @()
    $passCount = 0
    $failCount = 0
    $warningCount = 0

    foreach ($file in $files) {
        Write-Host "Checking: $($file.Name)"
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $lines = $content -split "`r?`n"

        $r = Check-SingleReport -FileName $file.Name -Content $content -Lines $lines -CheckType $CheckType
        $results += $r

        if ($r.OverallStatus -eq 'PASS') { $passCount++ }
        elseif ($r.OverallStatus -eq 'FAIL') { $failCount++ }
        else { $warningCount++ }
    }

    # Generate summary report
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $domain = Split-Path $ReportDir -Leaf
    $reportMd = Generate-QCReport -Results $results -ReportDir $ReportDir -Timestamp $timestamp -PassCount $passCount -FailCount $failCount -WarningCount $warningCount
    $outFile = Join-Path $OutputDir "QCReport_${domain}_$(Get-Date -Format 'yyyyMMdd_HHmmss').md"
    [System.IO.File]::WriteAllText($outFile, $reportMd, [System.Text.Encoding]::UTF8)

    # Also write a detail JSON for downstream processing
    $jsonFile = [System.IO.Path]::ChangeExtension($outFile, '.json')
    $results | ConvertTo-Json -Depth 10 | Out-File -FilePath $jsonFile -Encoding UTF8

    Write-Host "`nQC Report saved to: $outFile"
    Write-Host "JSON detail saved to: $jsonFile"
    Write-Host "Summary: PASS=$passCount, FAIL=$failCount, WARNING=$warningCount, Total=$($results.Count)"

    return $results
}

function Check-SingleReport {
    param($FileName, $Content, $Lines, $CheckType)

    $issues = @()
    $warnings = @()
    $info = @{}

    # --- Section presence checks ---
    $requiredSections = @(
        @{ Name='一、基本信息'; Pattern='##\s*一\s*、\s*基本信息'}
        @{ Name='二、关键字段'; Pattern='##\s*二\s*、\s*关键字段'}
        @{ Name='三、扩展与预留字段'; Pattern='##\s*三\s*、\s*扩展与预留字段'}
        @{ Name='四、直接关联表'; Pattern='##\s*四\s*、\s*直接关联表'}
        @{ Name='五、关系图'; Pattern='##\s*五\s*、\s*关系图'}
        @{ Name='六、样例与关键分布'; Pattern='##\s*六\s*、\s*样例与关键分布'}
        @{ Name='七、建模结论'; Pattern='##\s*七\s*、\s*建模结论'}
    )

    foreach ($sec in $requiredSections) {
        if ($Content -notmatch $sec.Pattern) {
            $issues += "缺失必备章节: $($sec.Name)"
        }
    }

    # --- Basic info table checks ---
    $basicInfoMatch = [regex]::Match($Content, '##\s*一\s*、\s*基本信息\s*\n\s*\|?.*?\n([\s\S]*?)(?=\n##(?!#)|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($basicInfoMatch.Success) {
        $basicBlock = $basicInfoMatch.Value
        $requiredBasicFields = @('Schema','表名','中文备注','数据层级','总记录数','总列数','显式主键','候选逻辑主键','对象判断','数据粒度')
        foreach ($f in $requiredBasicFields) {
            if ($basicBlock -notmatch [regex]::Escape($f)) {
                $issues += "基本信息表缺失字段行: $f"
            }
        }

        # Extract total columns and coverage
        $colCountMatch = [regex]::Match($basicBlock, '总列数.*?(\d+)')
        $info['TotalCols'] = if ($colCountMatch.Success) { [int]$colCountMatch.Groups[1].Value } else { $null }

        $coverageMatch = [regex]::Match($basicBlock, '字段覆盖率.*?\d+\s*/\s*\d+.*?\((\d+)%\)')
        if (-not $coverageMatch.Success) {
            $coverageMatch = [regex]::Match($basicBlock, '字段覆盖率.*?(\d+)%')
        }
        $info['Coverage'] = if ($coverageMatch.Success) { [int]$coverageMatch.Groups[1].Value } else { $null }

        if ($null -eq $info['Coverage']) {
            $warnings += "未找到字段覆盖率指标"
        } elseif ($info['Coverage'] -lt 90) {
            $issues += "字段覆盖率不足90%: $($info['Coverage'])%"
        }
    } else {
        $issues += "未找到基本信息章节"
    }

    # --- Key fields checks ---
    $keyFieldsMatch = [regex]::Match($Content, '##\s*二\s*、\s*关键字段\s*\n([\s\S]*?)(?=\n##\s*三\s*、|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($keyFieldsMatch.Success) {
        $keyBlock = $keyFieldsMatch.Groups[1].Value

        # Check field type annotations
        $fieldTypeKeywords = @('主标识字段','外部引用字段','准标识字段','数据类型字段')
        $hasFieldType = $fieldTypeKeywords | Where-Object { $keyBlock -match $_ }
        if (-not $hasFieldType) {
            $issues += "关键字段未标注字段类型(主标识/外部引用/准标识/数据类型)"
        }

        # Check column count in key fields tables
        $tableRows = [regex]::Matches($keyBlock, '^\|[^\n]+?\|') | Where-Object { $_.Value -match '^\|[^-]' }
        $uniqueCols = @{}
        foreach ($row in $tableRows) {
            $cols = $row.Value -split '\|' | Select-Object -Skip 1 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
            if ($cols.Count -gt 0) { $uniqueCols[$cols[0]] = 1 }
        }
        $reportedCols = $uniqueCols.Count
        $info['ReportedCols'] = $reportedCols

        if ($info['TotalCols'] -and $reportedCols -gt 0) {
            $calcCoverage = [math]::Floor(($reportedCols / $info['TotalCols']) * 100)
            if ($info['Coverage'] -and [math]::Abs($info['Coverage'] - $calcCoverage) -gt 5) {
                $warnings += "字段覆盖率声明值($($info['Coverage'])%)与章节统计($calcCoverage%)偏差超过5%"
            }
        }

        # Check for sample values support for ID/CODE/NO/NAME fields
        $idCodeFields = [regex]::Matches($keyBlock, '^\|\s*(\w*(?:ID|UUID|CODE|NO|NAME|ENAME)\w*)\s*\|', [System.Text.RegularExpressions.RegexOptions]::Multiline)
        if ($idCodeFields.Count -gt 0) {
            $sampleSupport = $keyBlock -match '样例值|值体系|样例|命中|NOT NULL.*值|默认.*值'
            if (-not $sampleSupport) {
                $warnings += "标识类/准标识类字段可能缺少样例值体系判定依据"
            }
        }
    } else {
        $issues += "未找到关键字段章节"
    }

    # --- Direct relation checks ---
    $relationMatch = [regex]::Match($Content, '##\s*四\s*、\s*直接关联表\s*\n([\s\S]*?)(?=\n##\s*五\s*、|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($relationMatch.Success) {
        $relBlock = $relationMatch.Groups[1].Value

        # Check for unverified relations
        $unverified = [regex]::Matches($relBlock, '待验证|待确认|可能关联|疑似关联')
        if ($unverified.Count -gt 0) {
            $issues += "存在未验证的关联关系(待验证/待确认/可能/疑似): $($unverified.Count)处"
        }

        # Check if relations use "已验证" or "无关联关系"
        $hasVerification = $relBlock -match '已验证|无关联关系'
        if (-not $hasVerification -and $relBlock -match '\w+_\w+') {
            $warnings += "关联关系未明确标注验证状态(已验证/无关联关系)"
        }

        # Check if same-prefix tables are written as confirmed without basis
        if ($relBlock -match '(?i)同前缀.*确认|前缀.*即为关联|同名.*关联') {
            $issues += "存在将同前缀表直接当作已确认关系的表述"
        }
    }

    # --- ASCII diagram check ---
    $diagramMatch = [regex]::Match($Content, '##\s*五\s*、\s*关系图\s*\n([\s\S]*?)(?=\n##\s*六\s*、|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($diagramMatch.Success) {
        $diaBlock = $diagramMatch.Groups[1].Value
        $hasAscii = $diaBlock -match '[┌┐└┘│─┤├┬┴┼>→←↑↓]|[\+\|\-]{3,}|\s+\|\s+\n\s*\|'
        if (-not $hasAscii) {
            $warnings += "关系图章节缺少ASCII图形表示"
        }
    } else {
        $issues += "缺失关系图章节"
    }

    # --- Sample data checks ---
    $sampleMatch = [regex]::Match($Content, '##\s*六\s*、\s*样例与关键分布\s*\n([\s\S]*?)(?=\n##\s*七\s*、|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($sampleMatch.Success) {
        $sampleBlock = $sampleMatch.Groups[1].Value
        if ($sampleBlock -notmatch '样例数据|样例|前\s*\d+\s*条') {
            $issues += "缺少样例数据展示"
        }
        if ($sampleBlock -notmatch '分布|GROUP BY|统计') {
            $warnings += "缺少关键分布统计(1~3个)"
        }
    } else {
        $issues += "缺失样例与关键分布章节"
    }

    # --- Modeling conclusion checks ---
    $conclusionMatch = [regex]::Match($Content, '##\s*七\s*、\s*建模结论\s*\n([\s\S]*?)(?=\n##(?!#)|\Z)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($conclusionMatch.Success) {
        $concBlock = $conclusionMatch.Groups[1].Value

        $requiredConcParts = @('查询事实','建模推断','风险与缺口','是否建议进入候选模型')
        foreach ($part in $requiredConcParts) {
            if ($concBlock -notmatch [regex]::Escape($part)) {
                $issues += "建模结论缺少部分: $part"
            }
        }

        # Check facts vs inference separation
        $factInferenceOk = ($concBlock -match '查询事实') -and ($concBlock -match '建模推断')
        if (-not $factInferenceOk) {
            $issues += "建模结论未明确区分查询事实与建模推断"
        }

        # Check final recommendation
        $recPattern = '(?i)建议\s*进入|有条件建议|暂不建议|建议'
        if ($concBlock -notmatch $recPattern) {
            $issues += "建模结论缺少明确的候选模型建议(建议/有条件建议/暂不建议)"
        }

        # Check for logical primary key basis
        if ($concBlock -notmatch '逻辑主键') {
            $warnings += "建模结论未提及逻辑主键"
        }

        # Check for SCD or table type
        if ($concBlock -notmatch '表类型|主表|明细表|快照表|维表') {
            $warnings += "建模结论未明确表类型(主表/明细表/快照表/维表)"
        }
    } else {
        $issues += "缺失建模结论章节"
    }

    # --- Content quality checks ---
    # Check if COUNT(*) is used vs SYSCAT.CARD
    if ($Content -match 'SYSCAT\.CARD|CARD\s*=') {
        $issues += "使用 SYSCAT.CARD 作为记录数来源(规范要求使用 COUNT(*))"
    }

    # Check if manual column count is mentioned
    if ($Content -match '人工计数|手动计数|肉眼计数') {
        $warnings += "报告中提到人工计数列数的方式"
    }

    # Check if COLCOUNT is referenced properly
    if ($Content -notmatch 'COLCOUNT|SYSCAT\.TABLES') {
        $warnings += "未引用 SYSCAT.TABLES.COLCOUNT 作为总列数权威来源"
    }

    # Check audit field normalization
    $auditPattern = '记录创建时间|记录创建者|记录修订时间|记录修订者|记录归档标记|记录归档日期'
    if ($Content -match 'CREATED|CREATE_TIME|MODIFIED|REVISOR|REC_CREATE|REC_REVISOR' -and $Content -notmatch $auditPattern) {
        $warnings += "存在审计字段但未使用规范化命名(记录创建时间/记录修订者等)"
    }

    # Determine overall status
    $overall = if ($issues.Count -gt 0) { 'FAIL' } elseif ($warnings.Count -gt 0) { 'WARNING' } else { 'PASS' }

    return [PSCustomObject]@{
        FileName = $FileName
        OverallStatus = $overall
        IssueCount = $issues.Count
        WarningCount = $warnings.Count
        Issues = $issues
        Warnings = $warnings
        Info = $info
    }
}

function Generate-QCReport {
    param($Results, $ReportDir, $Timestamp, $PassCount, $FailCount, $WarningCount)

    $total = $Results.Count
    $problemReports = $Results | Where-Object { $_.OverallStatus -ne 'PASS' }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("# ODS 分析报告质量检查报告")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("---")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("## 一、检查基本信息")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| 属性 | 值 |")
    [void]$sb.AppendLine("|:---|:---|")
    [void]$sb.AppendLine("| **检查时间** | $Timestamp |")
    [void]$sb.AppendLine("| **报告目录** | $ReportDir |")
    [void]$sb.AppendLine("| **检查报告总数** | $total |")
    [void]$sb.AppendLine("| **通过报告数** | $PassCount |")
    [void]$sb.AppendLine("| **警告报告数** | $WarningCount |")
    [void]$sb.AppendLine("| **不通过报告数** | $FailCount |")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("---")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("## 二、汇总统计")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| 指标 | 数值 |")
    [void]$sb.AppendLine("|:---|:---|")
    [void]$sb.AppendLine("| 格式与内容完整通过 | $PassCount |")
    [void]$sb.AppendLine("| 存在警告项 | $WarningCount |")
    [void]$sb.AppendLine("| 存在必改问题 | $FailCount |")
    [void]$sb.AppendLine("| 必改问题占比 | $([math]::Round(($FailCount/$total)*100,1))% |")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("---")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("## 三、问题汇总")
    [void]$sb.AppendLine("")

    if ($problemReports.Count -eq 0) {
        [void]$sb.AppendLine("所有报告检查通过，无问题。")
    } else {
        [void]$sb.AppendLine("### 必改问题报告列表")
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("| # | 报告文件名 | 状态 | 问题数 | 警告数 | 问题简述 |")
        [void]$sb.AppendLine("|:---|:---|:---|:---|:---|:---|")
        $idx = 1
        foreach ($r in $problemReports) {
            $issueSummary = if ($r.Issues.Count -gt 0) { ($r.Issues -join '；') } else { '-' }
            if ($issueSummary.Length -gt 60) { $issueSummary = $issueSummary.Substring(0,60) + '...' }
            [void]$sb.AppendLine("| $idx | $($r.FileName) | $($r.OverallStatus) | $($r.IssueCount) | $($r.WarningCount) | $issueSummary |")
            $idx++
        }
    }

    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("---")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("## 四、详细检查结果")
    [void]$sb.AppendLine("")

    foreach ($r in $Results) {
        [void]$sb.AppendLine("### $($r.FileName)")
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("| 检查项 | 状态 | 说明 |")
        [void]$sb.AppendLine("|:---|:---|:---|")

        $sectionsCheck = if (($r.Issues + $r.Warnings) -match '缺失必备章节') { '❌ 不通过' } else { '✅ 通过' }
        $basicInfoCheck = if (($r.Issues + $r.Warnings) -match '基本信息') { '⚠️ 需关注' } else { '✅ 通过' }
        $coverageCheck = if ($r.Issues -match '字段覆盖率') { '❌ 不通过' } elseif ($r.Warnings -match '字段覆盖率') { '⚠️ 需关注' } else { '✅ 通过' }
        $relationCheck = if ($r.Issues -match '关联') { '❌ 不通过' } elseif ($r.Warnings -match '关联') { '⚠️ 需关注' } else { '✅ 通过' }
        $conclusionCheck = if ($r.Issues -match '建模结论') { '❌ 不通过' } elseif ($r.Warnings -match '建模结论') { '⚠️ 需关注' } else { '✅ 通过' }
        $factCheck = if ($r.Issues -match '查询事实|建模推断') { '❌ 不通过' } else { '✅ 通过' }
        $sampleCheck = if ($r.Issues -match '样例') { '❌ 不通过' } elseif ($r.Warnings -match '样例') { '⚠️ 需关注' } else { '✅ 通过' }
        $recCheck = if ($r.Issues -match 'SYSCAT\.CARD|人工计数') { '❌ 不通过' } elseif ($r.Warnings -match 'COLCOUNT|审计字段') { '⚠️ 需关注' } else { '✅ 通过' }

        [void]$sb.AppendLine("| 章节完整性 | $sectionsCheck | 一~七章节是否齐全 |")
        [void]$sb.AppendLine("| 基本信息表 | $basicInfoCheck | Schema/表名/记录数/列数/粒度等 |")
        [void]$sb.AppendLine("| 字段覆盖率 | $coverageCheck | 是否 >= 90% 且统计准确 |")
        [void]$sb.AppendLine("| 字段类型标注 | $(if($r.Issues -match '字段类型'){'❌ 不通过'}elseif($r.Warnings -match '字段类型'){'⚠️ 需关注'}else{'✅ 通过'}) | 主标识/外部引用/准标识/数据类型 |")
        [void]$sb.AppendLine("| 关联关系验证 | $relationCheck | 是否已验证，无待验证残留 |")
        [void]$sb.AppendLine("| 事实推断分离 | $factCheck | 查询事实与建模推断是否分离 |")
        [void]$sb.AppendLine("| 建模结论 | $conclusionCheck | 表类型/逻辑主键/建议结论 |")
        [void]$sb.AppendLine("| 样例与分布 | $sampleCheck | 样例数据 + 关键分布统计 |")
        [void]$sb.AppendLine("| 数据来源规范 | $recCheck | COUNT(*)/COLCOUNT/审计字段 |")

        if ($r.Issues.Count -gt 0) {
            [void]$sb.AppendLine("")
            [void]$sb.AppendLine("**必改问题：**")
            foreach ($issue in $r.Issues) {
                [void]$sb.AppendLine("- ❌ $issue")
            }
        }
        if ($r.Warnings.Count -gt 0) {
            [void]$sb.AppendLine("")
            [void]$sb.AppendLine("**警告项：**")
            foreach ($warn in $r.Warnings) {
                [void]$sb.AppendLine("- ⚠️ $warn")
            }
        }
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("---")
        [void]$sb.AppendLine("")
    }

    [void]$sb.AppendLine("## 五、检查标准说明")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("本检查严格依据 `shutu-ods-analysis` 技能的以下核心原则执行：")
    [void]$sb.AppendLine("- **事实与推断分离**：关键结论必须区分查询事实与建模推断")
    [void]$sb.AppendLine("- **列覆盖 >= 90%**：报告中覆盖字段数 / 实际总列数 >= 90%")
    [void]$sb.AppendLine("- **关联必须验证**：关联关系必须 SQL JOIN 命中验证后输出，不得保留待验证（0行表除外）")
    [void]$sb.AppendLine("- **字段类型显式判定**：关键字段必须区分 主标识 / 外部引用 / 准标识 / 数据类型")
    [void]$sb.AppendLine("- **数据来源规范**：总列数来自 SYSCAT.TABLES.COLCOUNT，记录数来自 COUNT(*)")
    [void]$sb.AppendLine("- **审计字段规范化**：CREATED/UPDATED 等字段应规范化为记录创建时间/记录修订者等")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("> 生成时间: $Timestamp")

    return $sb.ToString()
}

# Main entry point for standalone execution
if ($MyInvocation.CommandOrigin -eq 'Runspace') {
    $params = @{}
    if ($env:REPORT_DIR) { $params['ReportDir'] = $env:REPORT_DIR }
    if ($env:REPORT_FILE) { $params['ReportFile'] = $env:REPORT_FILE }
    if ($env:OUTPUT_DIR) { $params['OutputDir'] = $env:OUTPUT_DIR }
    if ($env:CHECK_TYPE) { $params['CheckType'] = $env:CHECK_TYPE }

    if (-not $params.ContainsKey('ReportDir')) {
        Write-Host "Usage: Set env REPORT_DIR, then run this script. Or call Invoke-ReportQualityCheck directly."
        exit 1
    }
    Invoke-ReportQualityCheck @params
}
