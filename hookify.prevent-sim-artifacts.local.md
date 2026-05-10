---
name: prevent-sim-artifacts
enabled: true
event: bash
action: warn
pattern: "git add .*transcript|git add .*\\.wlf|git add .*\\.vcd|git add .*work/"
---
仿真产物（transcript、*.wlf、*.vcd、work/）不应提交到 git，请检查暂存内容。
