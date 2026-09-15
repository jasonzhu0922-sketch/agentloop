"""Regression coverage for the Skill-owned PPTX unified-theme transform."""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import defusedxml.minidom

import apply_unified_theme


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
COLORS = {
    "dk1": "24304A", "lt1": "FFFFFF", "dk2": "1B2440", "lt2": "E9EEF6",
    "accent1": "5B4BD6", "accent2": "E8503C", "accent3": "F5B33C",
    "accent4": "2FBFA6", "accent5": "EFEAFD", "accent6": "55516E",
    "hlink": "5B4BD6", "folHlink": "E8503C",
}


THEME_XML = b'''<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Original">
  <a:themeElements>
    <a:clrScheme name="Original">
      <a:dk1><a:srgbClr val="000000"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="112233"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="112233"/></a:accent1>
      <a:accent2><a:srgbClr val="445566"/></a:accent2>
      <a:accent3><a:srgbClr val="778899"/></a:accent3>
      <a:accent4><a:srgbClr val="AABBCC"/></a:accent4>
      <a:accent5><a:srgbClr val="CCDDEE"/></a:accent5>
      <a:accent6><a:srgbClr val="123456"/></a:accent6>
      <a:hlink><a:srgbClr val="654321"/></a:hlink>
      <a:folHlink><a:srgbClr val="FEDCBA"/></a:folHlink>
      <a:extLst><a:ext uri="preserve-me"/></a:extLst>
    </a:clrScheme>
    <a:fontScheme name="Original"><a:majorFont><a:latin typeface="Old Latin"/><a:ea typeface="Old EA"/></a:majorFont><a:minorFont><a:latin typeface="Old Latin"/><a:ea typeface="Old EA"/></a:minorFont></a:fontScheme>
  </a:themeElements>
</a:theme>'''

SLIDE_XML = b'''<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr dirty="0" lang="zh-CN"/><a:t>Keep this text</a:t></a:r><a:r><a:rPr dirty="0"/><a:t> and this</a:t></a:r></a:p></p:txBody><p:spPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld>
</p:sld>'''


class UnifiedThemeRegressionTest(unittest.TestCase):
    def test_existing_run_properties_remain_valid_and_unique(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.pptx"
            output = root / "themed.pptx"
            config = root / "theme.json"
            receipt = root / "receipt.json"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("ppt/theme/theme1.xml", THEME_XML)
                archive.writestr("ppt/slides/slide1.xml", SLIDE_XML)
                archive.writestr("[Content_Types].xml", "<Types/>")
            config.write_text(
                json.dumps(
                    {
                        "name": "Regression theme",
                        "colors": COLORS,
                        "colorMap": {
                            "112233": "5B4BD6",
                            "445566": "E8503C",
                            "778899": "F5B33C",
                            "AABBCC": "2FBFA6",
                            "CCDDEE": "EFEAFD",
                            "123456": "55516E",
                            "654321": "5B4BD6",
                            "FEDCBA": "E8503C",
                            "000000": "24304A",
                            "FFFFFF": "FFFFFF",
                            "EEEEEE": "E9EEF6",
                        },
                        "fonts": {"latin": "Aptos", "eastAsian": "Microsoft YaHei"},
                    }
                ),
                encoding="utf-8",
            )

            result = apply_unified_theme.apply_command(
                type(
                    "Args",
                    (),
                    {
                        "input": source,
                        "output": output,
                        "theme": config,
                        "report": receipt,
                        "require_complete_color_map": True,
                    },
                )()
            )
            self.assertIsNone(result)

            with zipfile.ZipFile(output) as archive:
                slide = defusedxml.minidom.parseString(archive.read("ppt/slides/slide1.xml"))
                theme = defusedxml.minidom.parseString(archive.read("ppt/theme/theme1.xml"))
            run_properties = slide.getElementsByTagNameNS(A_NS, "rPr")
            self.assertEqual([node.getAttribute("dirty") for node in run_properties], ["0", "0"])
            self.assertEqual(slide.getElementsByTagNameNS(A_NS, "srgbClr")[0].getAttribute("val"), "5B4BD6")
            self.assertEqual(theme.getElementsByTagNameNS(A_NS, "ext")[0].getAttribute("uri"), "preserve-me")
            self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["textPreserved"], True)


if __name__ == "__main__":
    unittest.main()
