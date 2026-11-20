// ============================================================================
// Sync Basic Test — preamble + data 序列
// ============================================================================

class sync_basic_test extends sync_base_test;

    `uvm_component_utils(sync_basic_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        sync_basic_seq seq;

        phase.raise_objection(this);
        assert_reset();

        `uvm_info(get_type_name(), "Starting Sync basic test...", UVM_LOW)

        seq = sync_basic_seq::type_id::create("seq");
        seq.num_samples = 1024;
        seq.start(env.agent.sqr);

        #(2000);
        `uvm_info(get_type_name(), "Sync test done", UVM_LOW)

        phase.drop_objection(this);
    endtask

endclass