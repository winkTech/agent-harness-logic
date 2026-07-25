%% 生成 RTL 验证测试向量
% 为 Verilog testbench 生成 LLR 输入和期望译码输出
addpath(pwd); addpath(fullfile(pwd,'src')); config;
H = generate_h_matrix(cfg);

fprintf('=== RTL Test Vector Generation ===\n');

num_tests = 5;
SNR_db = 3.0;  % 高 SNR 确保正确译码

for t = 1:num_tests
    % 随机信息位
    info = randi([0 1], cfg.K, 1);

    % 编码
    code = ldpc_encode_80211n(info, H, cfg);
    tx = 1 - 2 * double(code);

    % 添加噪声
    snr_lin = 10^(SNR_db/10);
    sigma2 = 1/(2*cfg.R*snr_lin);
    sigma = sqrt(sigma2);
    rx = tx + sigma * randn(cfg.N, 1);

    % LLR 计算
    llr_float = 2 * rx / sigma2;

    % 量化到 Q(10,4)
    LLR_q = round(llr_float * 16);
    LLR_q = max(min(LLR_q, 511), -512);  % 10-bit signed saturate

    % 浮点译码验证
    dec_float = ldpc_decoder_ms_pure(llr_float, H, 50, 0.75);
    if ~isequal(dec_float, info)
        fprintf('  Test %d: Float decode FAILED, retrying...\n', t);
        continue;  % 重试
    end

    % 写入文件
    fid_llr = fopen(sprintf('../rtl/02_sim/tb_llr_input_%d.hex', t), 'w');
    fid_exp = fopen(sprintf('../rtl/02_sim/tb_expected_output_%d.hex', t), 'w');

    for i = 1:cfg.N
        % 写入 10-bit signed hex (3 hex digits)
        val = LLR_q(i);
        if val < 0, val = 1024 + val; end  % 2's complement to unsigned
        fprintf(fid_llr, '%03x\n', val);
    end
    fclose(fid_llr);

    for i = 1:cfg.K
        fprintf(fid_exp, '%1d\n', info(i));
    end
    fclose(fid_exp);

    fprintf('  Test %d: Vectors generated (LLR=%d hex, Expected=%d hex)\n', ...
        t, cfg.N, cfg.K);
end

fprintf('=== Done: %d test vector sets generated ===\n', num_tests);
