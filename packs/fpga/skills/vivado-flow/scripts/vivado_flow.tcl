#==============================================================================
# vivado_flow.tcl — Vivado Non-Project Mode 全流程驱动
#
# 一个脚本覆盖 rtlcheck → synth → opt → place → route → bitstream。
# 每个阶段结束存 DCP，失败后可从任意阶段续跑，不必从头重综合。
#
# 用法:
#   vivado -mode batch -nojournal -nolog -source vivado_flow.tcl -tclargs <opts>
#
# 选项（CLI 优先级高于 -cfg 配置文件）:
#   -cfg <file>        配置文件（key = value，见 templates/flow.cfg）
#   -top <name>        顶层模块名                        [必填]
#   -part <part>       器件型号                          [必填]
#   -src <dir>         HDL 源目录（递归扫描）
#   -filelist <f>      .f 文件清单（给了就不扫 -src）
#   -xdc <dir|file>    约束目录或单个 .xdc
#   -out <dir>         输出根目录                        [默认 04_prj]
#   -from <stage>      起始阶段                          [默认 synth]
#   -to <stage>        结束阶段                          [默认 synth]
#   -mode default|ooc  ooc = out_of_context（单模块/CBB 评估）
#   -directive <d>     synth_design -directive
#   -impl-directive <d> place/route -directive
#   -define K=V        Verilog 宏（可重复）
#   -incdir <dir>      include 搜索路径（可重复）
#   -generic K=V       顶层 generic/parameter 覆盖（可重复）
#   -jobs N            并行线程数
#   -no-phys-opt       跳过 phys_opt_design
#   -no-fail           跑完所有阶段再判定，不在中途因门禁退出
#
# 阶段与产物:
#   rtlcheck  → rpt/rtl_drc.rpt, rtl_methodology.rpt        (仅 elaborate，秒级)
#   synth     → dcp/post_synth.dcp  + 全套综合报告
#   opt       → dcp/post_opt.dcp
#   place     → dcp/post_place.dcp  + 布局后时序
#   route     → dcp/post_route.dcp  + 时序/DRC/功耗
#   bitstream → bit/<top>.bit 或 .pdi（Versal 自动切 write_device_image）
#
# 退出码: 0 = 通过; 1 = 门禁阻断; 2 = 用法/环境错误
#==============================================================================

#------------------------------------------------------------------------------
# §0 版本与阶段定义
#------------------------------------------------------------------------------
set VIVADO_VER "unknown"
catch {set VIVADO_VER [version -short]}
set VER_NUM 0.0
if {[regexp {^(\d+)\.(\d+)} $VIVADO_VER -> _maj _min]} {
    set VER_NUM [expr {$_maj + $_min / 10.0}]
}

# 阶段顺序即依赖顺序；PREREQ 是续跑时要读回的 DCP（rtlcheck/synth 从源码起步）
set STAGES {rtlcheck synth opt place route bitstream}
array set PREREQ {
    rtlcheck  {}
    synth     {}
    opt       post_synth
    place     post_opt
    route     post_place
    bitstream post_route
}

proc stage_idx {s} {
    global STAGES
    return [lsearch -exact $STAGES $s]
}

proc die {msg {code 2}} {
    puts "ERROR: $msg"
    # 流程已经跑起来之后再失败(综合报错等), 也要落一份 flow_summary.json ——
    # 下游把这份 JSON 当唯一判定入口, 失败时没有它等于证据链断在最要紧的地方。
    # 参数解析阶段的 die 发生在 emit_summary 定义之前, 用 info procs 挡住。
    if {[llength [info procs emit_summary]]} {
        catch {emit_summary $msg}
    }
    exit $code
}

#------------------------------------------------------------------------------
# §1 参数解析：-cfg 先加载，CLI 再覆盖
#------------------------------------------------------------------------------
array set CFG {
    top {} part {} src {} filelist {} xdc {} out 04_prj
    from rtlcheck to synth mode default
    directive {} impl_directive {} jobs 0 phys_opt 1 fail_fast 1
}
set DEFINES  {}
set INCDIRS  {}
set GENERICS {}

proc load_cfg {path} {
    global CFG DEFINES INCDIRS GENERICS
    if {![file exists $path]} { die "配置文件不存在: $path" }
    set fh [open $path r]
    set txt [read $fh]
    close $fh
    foreach line [split $txt "\n"] {
        set line [string trim $line]
        if {$line eq "" || [string index $line 0] eq "#"} { continue }
        set idx [string first "=" $line]
        if {$idx < 0} { continue }
        set k [string trim [string range $line 0 [expr {$idx - 1}]]]
        set v [string trim [string range $line [expr {$idx + 1}] end]]
        switch -- $k {
            define  { lappend DEFINES  $v }
            incdir  { lappend INCDIRS  $v }
            generic { lappend GENERICS $v }
            default {
                if {[info exists CFG($k)]} {
                    set CFG($k) $v
                } else {
                    puts "\[flow\] WARNING: 配置文件里有未知键 '$k'，已忽略"
                }
            }
        }
    }
}

# 第一遍：只找 -cfg，保证 CLI 能覆盖配置文件
for {set i 0} {$i < [llength $argv]} {incr i} {
    if {[lindex $argv $i] eq "-cfg"} {
        load_cfg [lindex $argv [expr {$i + 1}]]
        break
    }
}

# 第二遍：CLI 覆盖
for {set i 0} {$i < [llength $argv]} {incr i} {
    set a [lindex $argv $i]
    set nxt [lindex $argv [expr {$i + 1}]]
    switch -- $a {
        -cfg             { incr i }
        -top             { set CFG(top)  $nxt ; incr i }
        -part            { set CFG(part) $nxt ; incr i }
        -src             { set CFG(src)  $nxt ; incr i }
        -filelist        { set CFG(filelist) $nxt ; incr i }
        -xdc             { set CFG(xdc)  $nxt ; incr i }
        -out             { set CFG(out)  $nxt ; incr i }
        -from            { set CFG(from) $nxt ; incr i }
        -to              { set CFG(to)   $nxt ; incr i }
        -mode            { set CFG(mode) $nxt ; incr i }
        -directive       { set CFG(directive) $nxt ; incr i }
        -impl-directive  { set CFG(impl_directive) $nxt ; incr i }
        -jobs            { set CFG(jobs) $nxt ; incr i }
        -define          { lappend DEFINES  $nxt ; incr i }
        -incdir          { lappend INCDIRS  $nxt ; incr i }
        -generic         { lappend GENERICS $nxt ; incr i }
        -no-phys-opt     { set CFG(phys_opt) 0 }
        -no-fail         { set CFG(fail_fast) 0 }
        default          { die "未知选项: $a" }
    }
}

if {$CFG(top)  eq ""} { die "缺少 -top（或配置文件里的 top）" }
if {$CFG(part) eq ""} { die "缺少 -part（或配置文件里的 part）" }
if {[stage_idx $CFG(from)] < 0} { die "-from 阶段名无效: $CFG(from)（可选: $STAGES）" }
if {[stage_idx $CFG(to)]   < 0} { die "-to 阶段名无效: $CFG(to)（可选: $STAGES）" }
if {[stage_idx $CFG(from)] > [stage_idx $CFG(to)]} {
    die "-from $CFG(from) 排在 -to $CFG(to) 之后，阶段区间为空"
}

set OUT  $CFG(out)
set RPT  $OUT/rpt
set DCP  $OUT/dcp
set BIT  $OUT/bit
file mkdir $RPT $DCP

#------------------------------------------------------------------------------
# §2 器件与版本自适应
#
# 为什么必须先查 part：新版才加入的器件系列在旧版里根本不存在，直接 synth_design
# 会在跑了几分钟之后才报错。先查一次，把"版本装错了"和"设计有问题"分开。
#------------------------------------------------------------------------------
set part_ok 0
catch {set part_ok [expr {[llength [get_parts -quiet $CFG(part)]] > 0}]}
if {!$part_ok} {
    die "本机 Vivado $VIVADO_VER 不认识器件 '$CFG(part)'。\
\n  可能原因: 该器件属于更新的发行版, 或对应器件包未安装。\
\n  排查: 在 Vivado 里跑 `get_parts -filter {FAMILY =~ \"*<系列>*\"}` 看可用型号。"
}

# Versal 系列出的是 .pdi（write_device_image），7 系列/UltraScale 出 .bit（write_bitstream）。
# 用系列属性判断而不是拿型号前缀猜，才能跟着版本走。
set ARCH ""
catch {set ARCH [get_property ARCHITECTURE [get_parts $CFG(part)]]}
set IS_VERSAL [regexp -nocase {versal|everest} $ARCH]

if {$CFG(jobs) > 0} { catch {set_param general.maxThreads $CFG(jobs)} }

puts "\[flow\] Vivado $VIVADO_VER | part=$CFG(part) arch=$ARCH | top=$CFG(top)"
puts "\[flow\] 阶段区间: $CFG(from) → $CFG(to) | mode=$CFG(mode) | out=$OUT"

#------------------------------------------------------------------------------
# §3 源文件收集：filelist 优先，其次目录递归扫描
#------------------------------------------------------------------------------
proc find_files {dir pat} {
    set out {}
    foreach f [glob -nocomplain -directory $dir *] {
        if {[file isdirectory $f]} {
            set out [concat $out [find_files $f $pat]]
        } elseif {[regexp $pat [file tail $f]]} {
            lappend out $f
        }
    }
    return $out
}

# .f 文件：支持 // 和 # 注释、+incdir+、+define+、-f 嵌套；相对路径按 .f 所在目录解析
proc parse_filelist {path {depth 0}} {
    global DEFINES INCDIRS
    if {$depth > 8} { die "filelist 嵌套超过 8 层，疑似循环引用: $path" }
    if {![file exists $path]} { die "filelist 不存在: $path" }
    set base [file dirname [file normalize $path]]
    set fh [open $path r] ; set txt [read $fh] ; close $fh
    set files {}
    foreach line [split $txt "\n"] {
        set line [string trim $line]
        if {$line eq "" || [string match "//*" $line] || [string match "#*" $line]} { continue }
        if {[string match "+incdir+*" $line]} {
            foreach d [split [string range $line 8 end] "+"] {
                if {$d ne ""} { lappend INCDIRS [file normalize [file join $base $d]] }
            }
            continue
        }
        if {[string match "+define+*" $line]} {
            foreach d [split [string range $line 8 end] "+"] {
                if {$d ne ""} { lappend DEFINES $d }
            }
            continue
        }
        if {[string match "-f *" $line] || [string match "-F *" $line]} {
            set sub [file join $base [string trim [string range $line 2 end]]]
            set files [concat $files [parse_filelist $sub [expr {$depth + 1}]]]
            continue
        }
        if {[string index $line 0] eq "-" || [string index $line 0] eq "+"} { continue }
        lappend files [file normalize [file join $base $line]]
    }
    return $files
}

set all_src {}
if {$CFG(filelist) ne ""} {
    set all_src [parse_filelist $CFG(filelist)]
    puts "\[flow\] 源清单: $CFG(filelist) → [llength $all_src] 个文件"
} elseif {$CFG(src) ne ""} {
    if {![file isdirectory $CFG(src)]} { die "-src 不是目录: $CFG(src)" }
    set all_src [find_files $CFG(src) {\.(sv|svh|v|vh|vhd|vhdl)$}]
    puts "\[flow\] 源目录: $CFG(src) → [llength $all_src] 个文件"
}

# 按后缀分派读取命令；.svh/.vh 是被 include 的头文件，不单独 read
set sv_files {} ; set v_files {} ; set vhd_files {}
foreach f $all_src {
    switch -- [string tolower [file extension $f]] {
        .sv          { lappend sv_files  $f }
        .v           { lappend v_files   $f }
        .vhd - .vhdl { lappend vhd_files $f }
        .svh - .vh   { lappend INCDIRS [file dirname $f] }
    }
}
set INCDIRS [lsort -unique $INCDIRS]

# 约束：-xdc 可以是目录也可以是单个文件
set xdc_files {}
if {$CFG(xdc) ne ""} {
    if {[file isdirectory $CFG(xdc)]} {
        set xdc_files [find_files $CFG(xdc) {\.xdc$}]
    } elseif {[file exists $CFG(xdc)]} {
        set xdc_files [list $CFG(xdc)]
    } else {
        die "-xdc 路径不存在: $CFG(xdc)"
    }
}

#------------------------------------------------------------------------------
# §4 通用工具过程
#------------------------------------------------------------------------------
# 单条报告不可用不该中断整体证据收集：旧版本没有某个 report_* 是常态，
# 记下来继续跑，比整条流程挂掉有用。
set SKIPPED_REPORTS {}
proc safe_report {label cmd} {
    global SKIPPED_REPORTS
    if {[catch {uplevel 1 $cmd} e]} {
        puts "\[flow\] 报告 '$label' 不可用（本版本可能不支持）: $e"
        lappend SKIPPED_REPORTS $label
        return 0
    }
    return 1
}

proc count_viols {getter waive} {
    set res [dict create Error 0 Critical 0 Warning 0 items {} waived {}]
    if {[catch {uplevel 1 $getter} viols]} { return $res }
    foreach v $viols {
        set sev "" ; catch {set sev [get_property SEVERITY $v]}
        set nm  "" ; catch {set nm  [get_property NAME $v]}
        set rule [lindex [split $nm "#"] 0]
        if {[lsearch -exact $waive $rule] >= 0} {
            dict lappend res waived "$sev/$nm"
            continue
        }
        switch -- $sev {
            "Error"            { dict incr res Error }
            "Critical Warning" { dict incr res Critical }
            "Warning"          { dict incr res Warning }
        }
        if {$sev eq "Error" || $sev eq "Critical Warning"} {
            dict lappend res items "$sev/$nm"
        }
    }
    return $res
}

proc get_slack {type} {
    set s "null"
    catch {
        set p [get_timing_paths -quiet -delay_type $type -max_paths 1 -nworst 1]
        if {[llength $p] > 0} { set s [format %.3f [get_property SLACK $p]] }
    }
    return $s
}

proc cell_count {pat} {
    if {[catch {llength [get_cells -hier -quiet -filter "REF_NAME =~ $pat"]} n]} { return 0 }
    return $n
}

# JSON 字符串转义。
#
# 旧实现用白名单 regsub 把字符类之外的东西全删掉, 造成两类损坏:
#   1. 白名单里没有中文, 也没有 '='。note_fail 生成的阻断原因全是中文, 于是
#      "synth: 综合后 critical=2 error=0" 被削成 "synth:  critical2 error0" ——
#      而 blocking[] 正是给人看"为什么被拦"的唯一入口, 削完就不可读了。
#   2. 反斜杠没被转义, Windows 路径 "C:\proj\04_prj" 里的 \p 不是合法 JSON
#      转义序列, 下游 JSON.parse 直接抛异常, 整份证据作废。
# 正确做法是只转义 JSON 规范要求的那几个字符, 其余(含中文)原样保留。
proc json_esc {s} {
    return [string map [list \\ {\\} \" {\"} \n {\n} \r {\r} \t {\t}] $s]
}

proc json_str_list {lst limit} {
    set out {}
    foreach it [lrange $lst 0 $limit] {
        lappend out "\"[json_esc $it]\""
    }
    return [join $out ,]
}

# NSTD-1 / UCIO-1 是"设计还没绑板子"的必然产物，不是 RTL 缺陷。
# 只有 XDC 里出现过 PACKAGE_PIN，才说明这是面向真实板卡的顶层，此时才该阻断。
set io_constrained 0
foreach x $xdc_files {
    if {[catch {set fh [open $x r]}]} { continue }
    set txt [read $fh] ; close $fh
    if {[regexp {PACKAGE_PIN} $txt]} { set io_constrained 1 ; break }
}
set IO_WAIVE [expr {$io_constrained ? {} : {NSTD-1 UCIO-1}}]

#------------------------------------------------------------------------------
# §5 读源 / 读 DCP
#------------------------------------------------------------------------------
proc read_sources {} {
    global sv_files v_files vhd_files xdc_files INCDIRS CFG
    if {[llength $sv_files] + [llength $v_files] + [llength $vhd_files] == 0} {
        die "没有找到任何 HDL 源文件。用 -src <dir> 或 -filelist <f> 指定。"
    }
    if {[llength $sv_files]  > 0} { read_verilog -sv $sv_files }
    if {[llength $v_files]   > 0} { read_verilog     $v_files  }
    if {[llength $vhd_files] > 0} { read_vhdl        $vhd_files }
    foreach x $xdc_files { read_xdc $x }
    if {[llength $xdc_files] == 0} {
        puts "\[flow\] WARNING: 无 XDC 约束 — 时序数字不可信，本次只有资源数据有效"
    }
}

proc resume_from {stage} {
    global PREREQ DCP
    set need $PREREQ($stage)
    if {$need eq ""} { return }
    set f $DCP/$need.dcp
    if {![file exists $f]} {
        die "阶段 '$stage' 需要上一阶段的检查点 $f，但它不存在。\
\n  先跑 -to [string map {post_ {}} $need] 生成它，或用 -from 从更早的阶段起步。"
    }
    puts "\[flow\] 从检查点续跑: $f"
    open_checkpoint $f
}

#------------------------------------------------------------------------------
# §6 阶段实现
#------------------------------------------------------------------------------
array set RESULT {}
set GATE_FAIL 0

proc note_fail {stage why} {
    global GATE_FAIL RESULT CFG
    set GATE_FAIL 1
    lappend RESULT(blocking) "$stage: $why"
    puts "\[flow\] 门禁阻断 @$stage — $why"
    if {$CFG(fail_fast)} {
        puts "\[flow\] fail-fast 生效，停止后续阶段（加 -no-fail 可跑完再判定）"
    }
}

#--- rtlcheck: 只 elaborate，秒级抓方法学违规 --------------------------------
proc do_rtlcheck {} {
    global CFG RPT DEFINES INCDIRS GENERICS IO_WAIVE RESULT
    puts "\[flow\] === rtlcheck: elaborate + RTL DRC ==="
    read_sources
    set a [list -top $CFG(top) -part $CFG(part) -rtl]
    foreach d $DEFINES  { lappend a -verilog_define $d }
    foreach g $GENERICS { lappend a -generic $g }
    if {[llength $INCDIRS] > 0} { lappend a -include_dirs $INCDIRS }
    # -rtl_skip_mlo 在部分版本上不存在，失败就退回不带该选项的调用
    if {[catch {synth_design {*}$a -rtl_skip_mlo}]} {
        if {[catch {synth_design {*}$a} e]} { die "elaborate 失败: $e" }
    }
    safe_report rtl_drc         "report_drc         -file $RPT/rtl_drc.rpt"
    safe_report rtl_methodology "report_methodology -file $RPT/rtl_methodology.rpt"
    set drc [count_viols {get_drc_violations -quiet} $IO_WAIVE]
    set mth [count_viols {get_methodology_violations -quiet} $IO_WAIVE]
    set crit [expr {[dict get $drc Critical] + [dict get $mth Critical]}]
    set errs [expr {[dict get $drc Error]    + [dict get $mth Error]}]
    set RESULT(rtlcheck) [list critical $crit error $errs \
        items [concat [dict get $drc items] [dict get $mth items]] \
        waived [concat [dict get $drc waived] [dict get $mth waived]]]
    if {$crit + $errs > 0} { note_fail rtlcheck "RTL DRC/方法学 critical=$crit error=$errs" }
}

#--- synth: 综合 + 全套证据报告 ----------------------------------------------
proc do_synth {} {
    global CFG RPT DCP DEFINES INCDIRS GENERICS IO_WAIVE RESULT
    puts "\[flow\] === synth: synth_design ==="
    read_sources
    set a [list -top $CFG(top) -part $CFG(part)]
    if {$CFG(mode) eq "ooc"}      { lappend a -mode out_of_context }
    if {$CFG(directive) ne ""}    { lappend a -directive $CFG(directive) }
    foreach d $DEFINES  { lappend a -verilog_define $d }
    foreach g $GENERICS { lappend a -generic $g }
    if {[llength $INCDIRS] > 0} { lappend a -include_dirs $INCDIRS }
    if {[catch {synth_design {*}$a} e]} { die "synth_design 失败: $e" }
    write_checkpoint -force $DCP/post_synth.dcp

    safe_report utilization       "report_utilization -hierarchical -file $RPT/synth_utilization.rpt"
    safe_report ram_utilization   "report_ram_utilization -file $RPT/synth_ram_utilization.rpt"
    safe_report timing_summary    "report_timing_summary -delay_type min_max -report_unconstrained -max_paths 10 -file $RPT/synth_timing_summary.rpt"
    safe_report check_timing      "check_timing -verbose -file $RPT/synth_check_timing.rpt"
    safe_report clock_networks    "report_clock_networks -file $RPT/synth_clock_networks.rpt"
    safe_report clock_interaction "report_clock_interaction -delay_type min_max -file $RPT/synth_clock_interaction.rpt"
    safe_report control_sets      "report_control_sets -verbose -file $RPT/synth_control_sets.rpt"
    safe_report high_fanout       "report_high_fanout_nets -fanout_greater_than 200 -max_nets 50 -file $RPT/synth_high_fanout.rpt"
    safe_report qor_suggestions   "report_qor_suggestions -file $RPT/synth_qor_suggestions.rpt"
    safe_report drc               "report_drc         -file $RPT/synth_drc.rpt"
    safe_report methodology       "report_methodology -file $RPT/synth_methodology.rpt"

    set cdc_crit 0 ; set cdc_warn 0 ; set cdc_parsed 0
    if {[safe_report cdc "report_cdc -details -file $RPT/synth_cdc.rpt"]} {
        if {![catch {set fh [open $RPT/synth_cdc.rpt r]}]} {
            set t [read $fh] ; close $fh
            set cdc_crit [regexp -all -line {^\s*\|\s*Critical\s*\|} $t]
            set cdc_warn [regexp -all -line {^\s*\|\s*Warning\s*\|}  $t]
            set cdc_parsed 1
        }
    }

    set drc [count_viols {get_drc_violations -quiet} $IO_WAIVE]
    set mth [count_viols {get_methodology_violations -quiet} $IO_WAIVE]
    set crit [expr {[dict get $drc Critical] + [dict get $mth Critical] + $cdc_crit}]
    set errs [expr {[dict get $drc Error]    + [dict get $mth Error]}]

    set n_ctrl "null"
    if {![catch {set cs [report_control_sets -return_string]}]} {
        if {[regexp {Total control sets\s*\|\s*(\d+)} $cs -> m]} { set n_ctrl $m }
    }

    set RESULT(synth) [list \
        wns [get_slack max] whs [get_slack min] \
        lut [cell_count {LUT*}] ff [cell_count {FD*}] \
        bram [cell_count {RAMB*}] uram [cell_count {URAM*}] \
        dsp [cell_count {DSP*}] srl [cell_count {SRL*}] \
        control_sets $n_ctrl \
        cdc_parsed $cdc_parsed cdc_critical $cdc_crit cdc_warning $cdc_warn \
        critical $crit error $errs \
        items [concat [dict get $drc items] [dict get $mth items]] \
        waived [concat [dict get $drc waived] [dict get $mth waived]]]

    if {$crit + $errs > 0} { note_fail synth "综合后 critical=$crit error=$errs" }
}

#--- opt / place / route ------------------------------------------------------
proc do_opt {} {
    global DCP RESULT
    puts "\[flow\] === opt: opt_design ==="
    if {[catch {opt_design} e]} { die "opt_design 失败: $e" }
    write_checkpoint -force $DCP/post_opt.dcp
    set RESULT(opt) [list wns [get_slack max] whs [get_slack min]]
}

proc do_place {} {
    global CFG DCP RPT RESULT
    puts "\[flow\] === place: place_design ==="
    set a {}
    if {$CFG(impl_directive) ne ""} { lappend a -directive $CFG(impl_directive) }
    if {[catch {place_design {*}$a} e]} { die "place_design 失败: $e" }
    if {$CFG(phys_opt)} { catch {phys_opt_design} }
    write_checkpoint -force $DCP/post_place.dcp
    safe_report place_timing "report_timing_summary -delay_type min_max -report_unconstrained -max_paths 10 -file $RPT/place_timing_summary.rpt"
    safe_report place_util   "report_utilization -hierarchical -file $RPT/place_utilization.rpt"
    set RESULT(place) [list wns [get_slack max] whs [get_slack min]]
}

proc do_route {} {
    global CFG DCP RPT IO_WAIVE RESULT
    puts "\[flow\] === route: route_design ==="
    set a {}
    if {$CFG(impl_directive) ne ""} { lappend a -directive $CFG(impl_directive) }
    if {[catch {route_design {*}$a} e]} { die "route_design 失败: $e" }
    if {$CFG(phys_opt)} { catch {phys_opt_design} }
    write_checkpoint -force $DCP/post_route.dcp

    safe_report route_timing "report_timing_summary -delay_type min_max -report_unconstrained -max_paths 10 -file $RPT/route_timing_summary.rpt"
    safe_report route_util   "report_utilization -hierarchical -file $RPT/route_utilization.rpt"
    safe_report route_drc    "report_drc -file $RPT/route_drc.rpt"
    safe_report route_status "report_route_status -file $RPT/route_status.rpt"
    safe_report power        "report_power -file $RPT/power.rpt"
    safe_report methodology  "report_methodology -file $RPT/route_methodology.rpt"

    # 布线后功耗才有意义（布局布线决定了走线电容），综合阶段的估算参考价值很低
    set pwr "null"
    if {![catch {set p [report_power -return_string]}]} {
        if {[regexp {Total On-Chip Power \(W\)\s*\|\s*([0-9.]+)} $p -> w]} { set pwr $w }
    }

    set drc [count_viols {get_drc_violations -quiet} $IO_WAIVE]
    set mth [count_viols {get_methodology_violations -quiet} $IO_WAIVE]
    set crit [expr {[dict get $drc Critical] + [dict get $mth Critical]}]
    set errs [expr {[dict get $drc Error]    + [dict get $mth Error]}]

    set wns [get_slack max] ; set whs [get_slack min]
    set RESULT(route) [list wns $wns whs $whs power_w $pwr \
        lut [cell_count {LUT*}] ff [cell_count {FD*}] \
        bram [cell_count {RAMB*}] uram [cell_count {URAM*}] dsp [cell_count {DSP*}] \
        critical $crit error $errs \
        items [concat [dict get $drc items] [dict get $mth items]] \
        waived [concat [dict get $drc waived] [dict get $mth waived]]]

    if {$crit + $errs > 0} { note_fail route "布线后 critical=$crit error=$errs" }
    # 布线后时序为负 = 这个设计上板会失败，是比综合阶段严重得多的信号
    if {$wns ne "null" && $wns < 0} { note_fail route "布线后 WNS=$wns ns < 0，时序未收敛" }
    if {$whs ne "null" && $whs < 0} { note_fail route "布线后 WHS=$whs ns < 0，保持时间违例" }
}

#--- bitstream ----------------------------------------------------------------
proc do_bitstream {} {
    global CFG BIT IS_VERSAL RESULT
    file mkdir $BIT
    if {$IS_VERSAL} {
        set f $BIT/$CFG(top).pdi
        puts "\[flow\] === bitstream: write_device_image（Versal 出 .pdi）==="
        if {[catch {write_device_image -force $f} e]} { die "write_device_image 失败: $e" }
    } else {
        set f $BIT/$CFG(top).bit
        puts "\[flow\] === bitstream: write_bitstream ==="
        if {[catch {write_bitstream -force $f} e]} { die "write_bitstream 失败: $e" }
    }
    set RESULT(bitstream) [list file $f exists [file exists $f] \
        size_bytes [expr {[file exists $f] ? [file size $f] : 0}]]
    puts "\[flow\] 比特流: $f"
}

#------------------------------------------------------------------------------
# §7 JSON 摘要生成 — 下游判定读这个，不要让人去 .rpt 里抄数字
#
# 这些 proc 必须定义在主循环(§8)**之前**。die 会调用 emit_summary, 而 die 最常
# 发生在综合阶段——那时若 proc 还没定义到, 失败路径依旧产不出证据。Tcl 是自上而
# 下执行的, 定义位置决定了它在哪个时刻起可用。
#------------------------------------------------------------------------------
proc kv_json {stage} {
    global RESULT
    if {![info exists RESULT($stage)]} { return "null" }
    set d $RESULT($stage)
    set parts {}
    foreach {k v} $d {
        if {$k eq "items" || $k eq "waived"} {
            lappend parts "\"$k\": \[[json_str_list $v 29]\]"
        } elseif {$v eq "null" || [string is double -strict $v] || $v eq "0" || $v eq "1"} {
            lappend parts "\"$k\": $v"
        } else {
            lappend parts "\"$k\": \"[json_esc $v]\""
        }
    }
    return "{[join $parts {, }]}"
}

# 读全局变量, 不存在时给默认值。
# emit_summary 现在也会被 die 调用, 而 die 可能发生在流程任意一步, 那时下面
# 引用的全局未必都已初始化。
proc _gv {name def} {
    upvar #0 $name v
    if {[info exists v]} { return $v }
    return $def
}

# 生成并落盘 flow_summary.json。
#
# fatal 非空表示这是异常退出路径(die)。以前 die 直接 exit, 跳过整个 JSON 生成块,
# 于是**最常见的失败——综合报错——根本产不出 flow_summary.json**, 而 SKILL.md
# 把这份 JSON 定为"Agent 的唯一判定入口"。下游拿不到证据只能去翻 stdout,
# 等于证据链在最需要它的时候断掉。
proc emit_summary {{fatal ""}} {
    global RESULT
    set ok [expr {([_gv GATE_FAIL 0] || $fatal ne "") ? 0 : 1}]

    set blocking [_gv RESULT(blocking) {}]
    if {$fatal ne ""} { lappend blocking $fatal }

    set xdcs [_gv xdc_files {}]
    set rpt  [_gv RPT ""]

    set json "{\n"
    append json "  \"tool\": \"vivado_flow\",\n"
    append json "  \"vivado_version\": \"[json_esc [_gv VIVADO_VER unknown]]\",\n"
    append json "  \"top\": \"[json_esc [_gv CFG(top) {}]]\",\n"
    append json "  \"part\": \"[json_esc [_gv CFG(part) {}]]\",\n"
    append json "  \"architecture\": \"[json_esc [_gv ARCH {}]]\",\n"
    append json "  \"mode\": \"[json_esc [_gv CFG(mode) default]]\",\n"
    append json "  \"ok\": [expr {$ok ? "true" : "false"}],\n"
    append json "  \"aborted\": [expr {$fatal ne "" ? "true" : "false"}],\n"
    append json "  \"stages_requested\": \"[json_esc [_gv CFG(from) {}]..[_gv CFG(to) {}]]\",\n"
    append json "  \"stages_run\": \[[json_str_list [_gv ran {}] 19]\],\n"
    append json "  \"constrained\": [expr {[llength $xdcs] > 0 ? "true" : "false"}],\n"
    append json "  \"io_constrained\": [expr {[_gv io_constrained 0] ? "true" : "false"}],\n"
    append json "  \"rtlcheck\": [kv_json rtlcheck],\n"
    append json "  \"synth\": [kv_json synth],\n"
    append json "  \"opt\": [kv_json opt],\n"
    append json "  \"place\": [kv_json place],\n"
    append json "  \"route\": [kv_json route],\n"
    append json "  \"bitstream\": [kv_json bitstream],\n"
    append json "  \"skipped_reports\": \[[json_str_list [_gv SKIPPED_REPORTS {}] 19]\],\n"
    append json "  \"blocking\": \[[json_str_list $blocking 19]\],\n"
    append json "  \"report_dir\": \"[json_esc $rpt]\",\n"
    append json "  \"checkpoint_dir\": \"[json_esc [_gv DCP ""]]\"\n"
    append json "}\n"

    # 目录可能还没建(早期 die)。整段包在 catch 里: -out 指到不可写的位置时
    # 静默跳过落盘, 但 stdout 上的 JSON 仍然有, 不会因为写文件失败再挂一次。
    if {$rpt ne ""} {
        catch {
            file mkdir $rpt
            set fh [open $rpt/flow_summary.json w]
            puts -nonewline $fh $json
            close $fh
        }
    }
    return [list $json $ok]
}

#------------------------------------------------------------------------------
# §8 主循环
#------------------------------------------------------------------------------
set i_from [stage_idx $CFG(from)]
set i_to   [stage_idx $CFG(to)]
set ran {}

# rtlcheck 会建立一个 elaborate 后的设计，和后续综合不共存；两者都要时分开跑
if {$i_from == 0 && $i_to > 0} {
    do_rtlcheck
    lappend ran rtlcheck
    if {$GATE_FAIL && $CFG(fail_fast)} {
        set i_from 99
    } else {
        catch {close_design}
        set i_from 1
    }
}

if {$i_from <= $i_to} {
    resume_from [lindex $STAGES $i_from]
    for {set i $i_from} {$i <= $i_to} {incr i} {
        set s [lindex $STAGES $i]
        switch -- $s {
            rtlcheck  { do_rtlcheck }
            synth     { do_synth }
            opt       { do_opt }
            place     { do_place }
            route     { do_route }
            bitstream { do_bitstream }
        }
        lappend ran $s
        if {$GATE_FAIL && $CFG(fail_fast)} { break }
    }
}

lassign [emit_summary] json ok
puts $json
puts "RESULT: [expr {$ok ? "PASS" : "FAIL"}]"
exit [expr {$ok ? 0 : 1}]
