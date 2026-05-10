---
name: prevent-main-commit
enabled: true
event: bash
action: block
pattern: "git commit.*"
condition: "git branch --show-current | grep -q main"
---
禁止在 main 分支上直接提交！请先创建功能分支再提交。
