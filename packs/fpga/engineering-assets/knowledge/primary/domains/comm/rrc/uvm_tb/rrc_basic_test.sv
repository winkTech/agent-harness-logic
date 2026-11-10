// ============================================================================
// RRC Basic Test — 定向 QPSK 序列
// ============================================================================

class rrc_basic_test extends rrc_base_test;

    `uvm_component_utils(rrc_basic_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        rrc_qpsk_seq seq;

        phase.raise_objection(this);

        assert_reset();

        `uvm_info(get_type_name(), "Starting RRC QPSK test...", UVM_LOW)

        seq = rrc_qpsk_seq::type_id::create("seq");
        seq.num_symbols = 32;  // 32 sym × 4 samples = 128 output samples

        seq.start(env.agent.sqr);

        // 等待流水线排空: span=8 sym × 4 样点/sym × 安全因子
        #(32 * 4 * 10);
        `uvm_info(get_type_name(), "RRC QPSK test done", UVM_LOW)

        phase.drop_objection(this);
    endtask

endclass