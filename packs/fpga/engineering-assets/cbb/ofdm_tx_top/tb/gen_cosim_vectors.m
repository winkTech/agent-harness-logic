function gen_cosim_vectors(out_dir)
%GEN_COSIM_VECTORS  为 tb_tx_cosim 组装四调制向量集
%
%   用法: gen_cosim_vectors('<repo>/engineering-assets/var/build/ofdm_tx_top')
%
%   权威在 golden 的 models/comm/ofdm/src/rtl_mirror_tx.m —— 本脚本只做**组装**
%   (循环四种调制并拼接), 不复制任何镜像逻辑。golden 自带的 generate_vectors.m
%   是单配置导出 (供 run_ofdm_sim 用); cosim 需要四调制同批, 故由消费侧组装。
%
%   产物 (out_dir):
%     tx_bits.hex      4 帧 x 8 符号 x 48 = 1536 行比特组
%     expected_tx.hex  4 帧 x 8 符号 x 80 = 2560 行期望样点 (0 容差)
%     vector_config.txt
%
%   规模说明: 准入门 G-B-03 要求 total >= 2048 样点, 故每帧 8 符号
%   (4 x 8 x 80 = 2560)。种子固定, 结果可复现。

    if nargin < 1 || isempty(out_dir)
        error('gen_cosim_vectors: 需指定输出目录');
    end
    here   = fileparts(mfilename('fullpath'));
    golden = fullfile(here, '..', '..', '..', '..', 'models', 'comm', 'ofdm', 'src');
    if ~exist(fullfile(golden, 'rtl_mirror_tx.m'), 'file')
        error('gen_cosim_vectors: 找不到 golden 镜像 %s', golden);
    end
    addpath(golden);

    mods = {'BPSK','QPSK','16QAM','64QAM'};
    NSYM = 8;

    rng(20260801);
    fb = fopen(fullfile(out_dir, 'tx_bits.hex'), 'w');
    fe = fopen(fullfile(out_dir, 'expected_tx.hex'), 'w');
    fc = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fc, 'N_FRAME=%d\nN_SYM=%d\nFFT_N=64\nCP_LEN=16\nTOLERANCE_LSB=0\n', ...
            numel(mods), NSYM);
    fprintf(fc, 'SOURCE=models/comm/ofdm/src/rtl_mirror_tx.m (bit-true mirror)\n');

    for m = 1:numel(mods)
        nb   = mod_nbits(mods{m});
        bits = randi([0 1], NSYM*48*nb, 1);
        out  = rtl_mirror_tx(bits, mods{m}, NSYM);

        fprintf(fc, 'FRAME%d_MOD=%d  # %s\n', m-1, m-1, mods{m});
        fprintf(fb, '%02x\n', out.bit_groups);
        u32 = bitor(bitshift(uint32(typecast(int16(imag(out.samples)),'uint16')),16), ...
                     uint32(typecast(int16(real(out.samples)),'uint16')));
        fprintf(fe, '%08x\n', u32);
        fprintf('  %-6s %4d 比特组, %4d 期望样点\n', ...
                mods{m}, numel(out.bit_groups), numel(out.samples));
    end
    fclose(fb); fclose(fe); fclose(fc);
    fprintf('[gen_cosim_vectors] %d 帧 x %d 符号 = %d 样点 -> %s\n', ...
            numel(mods), NSYM, numel(mods)*NSYM*80, out_dir);
end

function nb = mod_nbits(mt)
    switch mt
        case 'BPSK',  nb = 1;
        case 'QPSK',  nb = 2;
        case '16QAM', nb = 4;
        case '64QAM', nb = 6;
        otherwise, error('未知调制: %s', mt);
    end
end
