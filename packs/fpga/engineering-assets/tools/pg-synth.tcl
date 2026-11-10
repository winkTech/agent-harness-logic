# pg-synth.tcl — CBB 生产级准入 G-C-01/02/03 综合证据生成
#
# 用法 (通常经 tools/pg-synth.cjs 调用, 不手工拼参数):
#   vivado -mode batch -nojournal -log <outdir>/synth.log \
#          -source pg-synth.tcl -tclargs <part> <top> <outdir> <incdir|-> <file>...
#
#   <file> 按扩展名分派: .sv -> SystemVerilog, .v -> Verilog, .xdc/.sdc -> 约束
#
# 产出 (全部落在 <outdir>, 即 var/gates/pg/<asset_uid>/):
#   timing-summary.rpt  G-C-01 判据来源 (时钟周期 + 每时钟 WNS)
#   utilization.rpt     G-C-02 判据来源 (LUT/FF/BRAM/DSP 实测)
#   clocks.rpt          时钟定义交叉核对
#   synth.log           G-C-03 判据来源 ([Synth 8-6896] initial 是否被忽略)
#   synth-meta.json     运行元数据 (工具版本/约束装载状态)
#
# 注意: synth.log 必须由 -log 直接写入 <outdir>, gate-runner 的 G-C-03
#       从该路径读取综合器对 initial 块的裁决。

set part   [lindex $argv 0]
set top    [lindex $argv 1]
set outdir [lindex $argv 2]
set incdir [lindex $argv 3]
set mode   [lindex $argv 4]
set flist  [lrange $argv 5 end]

file mkdir $outdir

set vfiles {}
set svfiles {}
set xdcfiles {}
foreach f $flist {
    switch -- [string tolower [file extension $f]] {
        .sv     { lappend svfiles  $f }
        .v      { lappend vfiles   $f }
        .xdc -
        .sdc    { lappend xdcfiles $f }
        default { puts "\[pg-synth\] 跳过未识别文件: $f" }
    }
}

create_project -in_memory -part $part

if {[llength $vfiles]}  { read_verilog $vfiles }
if {[llength $svfiles]} { read_verilog -sv $svfiles }

# 约束单独 catch 并如实记录状态: 约束缺失/装载失败会让 G-C-01 判 FAIL,
# 必须可见, 不得静默吞掉。
set xdc_status "none"
set xdc_error  ""
if {[llength $xdcfiles]} {
    if {[catch {read_xdc $xdcfiles} err]} {
        set xdc_status "error"
        set xdc_error  $err
        puts "\[pg-synth\] 约束读取失败: $err"
    } else {
        set xdc_status "loaded"
    }
}

# CBB 是核而非整片设计: 独立综合会给每个端口插 IBUF/OBUF, 焊盘延时(实测
# OBUF 约 2.5ns)会把核级时序判死, 而集成后这些端口只是片内网线。故默认按
# out_of_context 综合(Xilinx 表征 IP 核的标准做法), 不插 I/O 缓冲。
# 模式写入 synth-meta.json, 不做隐藏假设; 需要整片视角时传 mode=top。
set synth_args [list -top $top -part $part]
if {$mode eq "ooc"} { lappend synth_args -mode out_of_context }
if {$incdir ne "-"} { lappend synth_args -include_dirs $incdir }

if {[catch {synth_design {*}$synth_args} err]} {
    puts "\[pg-synth\] 综合失败: $err"
    set fp [open "$outdir/synth-meta.json" w]
    puts $fp "{\"synth_status\":\"error\",\"xdc_status\":\"$xdc_status\",\"top\":\"$top\",\"part\":\"$part\"}"
    close $fp
    exit 1
}

report_timing_summary -file $outdir/timing-summary.rpt -warn_on_violation
report_utilization    -file $outdir/utilization.rpt
report_clocks         -file $outdir/clocks.rpt

# 机器可读元数据; WNS/周期/资源由 gate-runner 从上述 rpt 解析, 此处不复述
# (避免同一事实两处记录而漂移)
set fp [open "$outdir/synth-meta.json" w]
puts $fp "{"
puts $fp "  \"synth_status\": \"ok\","
puts $fp "  \"synth_mode\": \"$mode\","
puts $fp "  \"xdc_status\": \"$xdc_status\","
puts $fp "  \"xdc_error\": \"[string map {\" ' \\ /} $xdc_error]\","
puts $fp "  \"top\": \"$top\","
puts $fp "  \"part\": \"$part\","
puts $fp "  \"vivado_version\": \"[version -short]\""
puts $fp "}"
close $fp

puts "\[pg-synth\] 完成: $outdir"
exit 0
