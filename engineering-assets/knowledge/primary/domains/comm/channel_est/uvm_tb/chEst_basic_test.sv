// ============================================================================
// ChEst Basic Test
// ============================================================================

class chEst_basic_test extends chEst_base_test;

    `uvm_component_utils(chEst_basic_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        chEst_basic_seq seq;

        phase.raise_objection(this);
        assert_reset();

        `uvm_info(get_type_name(), "Starting ChEst basic test...", UVM_LOW)

        seq = chEst_basic_seq::type_id::create("seq");
        seq.num_subcarriers = 64;
        seq.num_symbols = 1;
        seq.start(env.agent.sqr);

        #(2000);  // 等待流水线完成
        `uvm_info(get_type_name(), "ChEst test done", UVM_LOW)

        phase.drop_objection(this);
    endtask

endclass