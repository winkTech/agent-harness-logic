#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ensureProjectDirs,
  modulePaths,
  readDirectoryContract,
  writeDirectoryContract,
} = require('./lib/project-directory-contract.cjs');

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/init-module.cjs <module_name> [data_width]',
    '',
    'Creates:',
    '  01_src/00_hdl/<module>/<module>.sv',
    '  02_sim/<module>/tb_<module>.sv',
  ].join('\n');
}

function validModuleName(name) {
  return /^[a-z][a-z0-9_]*$/.test(name);
}

function ensureFile(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function rtlTemplate(moduleName, dataWidth) {
  return `module ${moduleName} #(
  parameter int P_DATA_WIDTH = ${dataWidth}
) (
  input  logic                    i_clk,
  input  logic                    i_rst,
  input  logic                    ri_in_valid,
  input  logic [P_DATA_WIDTH-1:0] ri_in_data,
  output logic                    ro_in_ready,
  output logic                    ro_out_valid,
  output logic [P_DATA_WIDTH-1:0] ro_out_data,
  input  logic                    ri_out_ready
);

  logic [P_DATA_WIDTH-1:0] ri_data;
  logic                   r_valid;

  always_ff @(posedge i_clk) begin
    if (i_rst) begin
      ri_data      <= '0;
      r_valid      <= 1'b0;
      ro_in_ready  <= 1'b1;
      ro_out_valid <= 1'b0;
      ro_out_data  <= '0;
    end else begin
      ro_in_ready  <= !r_valid || ri_out_ready;
      ro_out_valid <= r_valid;
      if (ri_in_valid && ro_in_ready) begin
        ri_data     <= ri_in_data;
        ro_out_data <= ri_in_data;
        r_valid     <= 1'b1;
      end else if (ri_out_ready) begin
        r_valid <= 1'b0;
      end
    end
  end

endmodule
`;
}

function tbTemplate(moduleName, dataWidth) {
  return '`timescale 1ns/1ps\n'
    + `module tb_${moduleName};
  localparam int P_DATA_WIDTH = ${dataWidth};

  logic i_clk;
  logic i_rst;
  logic ri_in_valid;
  logic [P_DATA_WIDTH-1:0] ri_in_data;
  logic ro_in_ready;
  logic ro_out_valid;
  logic [P_DATA_WIDTH-1:0] ro_out_data;
  logic ri_out_ready;

  ${moduleName} #(
    .P_DATA_WIDTH(P_DATA_WIDTH)
  ) u_dut (
    .i_clk(i_clk),
    .i_rst(i_rst),
    .ri_in_valid(ri_in_valid),
    .ri_in_data(ri_in_data),
    .ro_in_ready(ro_in_ready),
    .ro_out_valid(ro_out_valid),
    .ro_out_data(ro_out_data),
    .ri_out_ready(ri_out_ready)
  );

  initial i_clk = 1'b0;
  always #5 i_clk = ~i_clk;

  initial begin
    i_rst = 1'b1;
    ri_in_valid = 1'b0;
    ri_in_data = '0;
    ri_out_ready = 1'b1;
    repeat (4) @(posedge i_clk);
    i_rst = 1'b0;
    @(posedge i_clk);
    ri_in_valid = 1'b1;
    ri_in_data = 'h5a;
    @(posedge i_clk);
    ri_in_valid = 1'b0;
    repeat (4) @(posedge i_clk);
    if (!ro_out_valid || ro_out_data !== 'h5a) begin
      $display("FAIL: ${moduleName} basic pass-through");
      $finish;
    end
    $display("PASS: ${moduleName}");
    $finish;
  end

  initial begin
    $dumpfile("02_sim/${moduleName}/${moduleName}.vcd");
    $dumpvars(0, tb_${moduleName});
  end
endmodule
`;
}

function main() {
  const moduleName = process.argv[2] || '';
  const dataWidth = Number.parseInt(process.argv[3] || '16', 10);
  if (!validModuleName(moduleName) || !Number.isInteger(dataWidth) || dataWidth <= 0) {
    console.error(usage());
    process.exit(1);
  }

  const root = process.cwd();
  const paths = modulePaths(moduleName);
  ensureProjectDirs(root, { modules: [moduleName] });
  if (!readDirectoryContract(root)) {
    writeDirectoryContract(root, { projectName: path.basename(root), modules: [moduleName] });
  }

  const wroteRtl = ensureFile(path.join(root, paths.rtl), rtlTemplate(moduleName, dataWidth));
  const wroteTb = ensureFile(path.join(root, paths.tb), tbTemplate(moduleName, dataWidth));
  console.log(JSON.stringify({
    status: 'ok',
    module: moduleName,
    rtl: paths.rtl.replace(/\\/g, '/'),
    tb: paths.tb.replace(/\\/g, '/'),
    wroteRtl,
    wroteTb,
  }, null, 2));
}

main();
