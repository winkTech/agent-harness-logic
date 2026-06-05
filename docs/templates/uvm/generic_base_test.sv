// ============================================================================
// 通用 Base Test — 所有算法 test 的基类
// 子类指定: s_axis_width / m_axis_width / vec_dir
// ============================================================================

class generic_base_test extends uvm_test;

    generic_env env;

    // ---- 虚接口参数 (子类可改) ----
    int  s_axis_width = 32;
    int  m_axis_width = 32;
    string vec_dir    = ".";

    `uvm_component_utils_begin(generic_base_test)
        `uvm_field_int(s_axis_width, UVM_DEFAULT)
        `uvm_field_int(m_axis_width, UVM_DEFAULT)
    `uvm_component_utils_end

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);

        // 设置虚接口: 前两个用 s_axis, out_mon 用 m_axis
        set_vif("env.agent.drv",    "vif", s_axis_width, "s_axis_vif");
        set_vif("env.agent.in_mon", "vif", s_axis_width, "s_axis_vif");
        set_vif("env.agent.out_mon", "vif", m_axis_width, "m_axis_vif");

        // 设置 golden 路径
        uvm_config_db #(string)::set(this, "env.sb", "vec_dir", vec_dir);

        env = generic_env::type_id::create("env", this);
    endfunction

    // ---- 设置虚接口 (key = 顶层 config_db 中的名字) ----
    function void set_vif(string comp_path, string field, int width, string cfg_key);
        if (width == 16) begin
            virtual axi_stream_if #(16) vif;
            if (!uvm_config_db #(virtual axi_stream_if #(16))::get(this, "", cfg_key, vif))
                `uvm_fatal("NOVIF", $sformatf("%s (#16) not set in config_db", cfg_key))
            uvm_config_db #(virtual axi_stream_if #(16))::set(this, comp_path, field, vif);
        end else if (width == 32) begin
            virtual axi_stream_if #(32) vif;
            if (!uvm_config_db #(virtual axi_stream_if #(32))::get(this, "", cfg_key, vif))
                `uvm_fatal("NOVIF", $sformatf("%s (#32) not set in config_db", cfg_key))
            uvm_config_db #(virtual axi_stream_if #(32))::set(this, comp_path, field, vif);
        end else begin
            `uvm_fatal("BADWIDTH", $sformatf("Unsupported axi_stream_if width: %0d", width))
        end
    endfunction

    // ---- 复位 ----
    task assert_reset(int cycles = 20);
        virtual reset_if vif;
        if (!uvm_config_db #(virtual reset_if)::get(this, "", "reset_vif", vif))
            `uvm_fatal("NORST", "reset_vif not set in config_db")
        @(posedge vif.clk);
        force vif.rst_n = 1'b0;
        repeat(cycles) @(posedge vif.clk);
        force vif.rst_n = 1'b1;
        repeat(5) @(posedge vif.clk);
        `uvm_info(get_type_name(), $sformatf("Reset completed (%0d cycles)", cycles), UVM_MEDIUM)
    endtask

    function void end_of_elaboration_phase(uvm_phase phase);
        uvm_top.print_topology();
    endfunction

    function void report_phase(uvm_phase phase);
        uvm_report_server svr = uvm_report_server::get_server();
        if (svr.get_severity_count(UVM_FATAL) +
            svr.get_severity_count(UVM_ERROR) == 0)
            `uvm_info(get_type_name(), "*** TEST PASSED ***", UVM_LOW)
        else
            `uvm_info(get_type_name(), "*** TEST FAILED ***", UVM_LOW)
    endfunction

endclass