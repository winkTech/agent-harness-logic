---
name: prevent-large-files
enabled: true
event: bash
action: warn
pattern: "git add.*"
condition: "git diff --cached --name-only 2>/dev/null | xargs -r ls -la 2>/dev/null | awk '$5 > 50000000' | grep -q ."
---
暂存区中包含超过 50MB 的大文件，请确认已添加到 .gitignore。
