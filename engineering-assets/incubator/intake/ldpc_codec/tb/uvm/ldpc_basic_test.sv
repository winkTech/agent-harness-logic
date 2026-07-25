// ============================================================================
// LDPC Decoder Basic Test
// 从 MATLAB 预生成的 .hex 文件加载测试向量
// ============================================================================

class ldpc_basic_test extends ldpc_base_test;

    `uvm_component_utils(ldpc_basic_test)

    int test_id = 0;
    string vec_dir;

    function new(string name = "ldpc_basic_test", uvm_component parent = null);
        super.new(name, parent);
    endfunction : new

    virtual function void build_phase(uvm_phase phase);
        // 获取向量路径 (config_db)
        if (!uvm_config_string::get(this, "", "vec_dir", vec_dir)) begin
            vec_dir = "../golden_model/vectors/";
        end
        if (!uvm_config_int::get(this, "", "test_id", test_id)) begin
            test_id = 0;
        end
        `uvm_info(get_type_name(), $sformatf("Vector dir: %s, test_id: %0d", vec_dir, test_id), UVM_MEDIUM)
        super.build_phase(phase);
    endfunction : build_phase

    virtual task run_phase(uvm_phase phase);
        ldpc_basic_test_seq seq;

        phase.raise_objection(this);

        seq = ldpc_basic_test_seq::type_id::create("seq");
        seq.test_id = test_id;
        seq.start(m_env.m_agent.m_sequencer);

        // 等待 decode 完成
        #10000;

        phase.drop_objection(this);
    endtask : run_phase

endclass : ldpc_basic_test
