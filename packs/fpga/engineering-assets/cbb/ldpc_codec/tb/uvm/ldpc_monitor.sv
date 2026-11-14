// ============================================================================
// LDPC Decoder Monitor — 监测解码输出 (1-bit) + 覆盖率收集
// ============================================================================

class ldpc_monitor extends uvm_monitor;

    virtual axi_stream_if #(1) vif;    // 1-bit decoded output
    uvm_analysis_port #(ldpc_seq_item) item_collected_port;

    // ---- 覆盖率: 解码统计 ----
    int   block_count;
    int   block_bit_count;
    int   blocks_with_errors;
    int   total_decoded_bits;

    covergroup decoder_cg;
        // 码块大小分布
        BLOCK_SIZE: coverpoint block_bit_count {
            bins small  = {[1:100]};
            bins med    = {[101:500]};
            bins large  = {[501:1944]};    // 802.11n max
        }
        // 解码结果统计
        DECODE_RESULT: coverpoint (blocks_with_errors > 0) {
            bins all_ok   = {0};
            bins has_err  = {1};
        }
    endgroup

    `uvm_component_utils(ldpc_monitor)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        item_collected_port = new("item_collected_port", this);
        decoder_cg = new();
        block_count = 0;
        block_bit_count = 0;
        blocks_with_errors = 0;
        total_decoded_bits = 0;
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(virtual axi_stream_if #(1))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "ldpc_monitor: vif #1 not set")
    endfunction

    task run_phase(uvm_phase phase);
        forever begin
            @(vif.mon_cb);
            if (vif.mon_cb.tvalid && vif.mon_cb.tready) begin
                ldpc_seq_item item = ldpc_seq_item::type_id::create("item", this);

                // 捕获 1-bit 解码数据
                item.decoded_bit = vif.mon_cb.tdata[0];
                item.last        = vif.mon_cb.tlast;
                item.timestamp   = $time;
                item.block_id    = block_count;
                item.bit_idx     = block_bit_count;

                // 统计
                total_decoded_bits++;
                block_bit_count++;

                if (vif.mon_cb.tlast) begin
                    block_count++;
                    block_bit_count = 0;
                end

                // 采样 covergroup
                decoder_cg.sample();

                // 发送到 analysis_port (scoreboard)
                item_collected_port.write(item);
            end
        end
    endtask

    function void report_phase(uvm_phase phase);
        `uvm_info(get_type_name(),
            $sformatf("  LDPC Monitor Summary:"), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("    Blocks decoded: %0d", block_count), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("    Total bits:     %0d", total_decoded_bits), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("    Blocks w/ err:  %0d", blocks_with_errors), UVM_MEDIUM)
    endfunction : report_phase

endclass : ldpc_monitor
