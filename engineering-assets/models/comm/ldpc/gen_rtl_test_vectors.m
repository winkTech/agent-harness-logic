%% 生成 RTL 验证测试向量
% 为 Verilog testbench 生成 LLR 输入和期望译码输出
addpath(pwd); addpath(fullfile(pwd,'src')); config;
H = generate_h_matrix(cfg);

fprintf('=== RTL Test Vector Generation ===\n');

% 固定随机种子: 向量是验收证据, 必须可复现。
% 治理规范 G-C-05 要求"同 seed 双跑 bit-identical", 无种子则每次导出的
% 期望值都不同, 任何比对结果都无法复查。
rng(20260725, 'twister');

% 向量权威位置 = models/<domain>/<algo>/vectors/ (治理规范 §5.5 V-1)。
% 原路径 ../rtl/02_sim/ 是迁移前的旧布局, 目录已不存在 —— 导出会静默失败,
% 这正是 vectors/ 长期为空、G-B-03 一直 blocked 的原因。
vec_dir = fullfile(fileparts(mfilename('fullpath')), 'vectors');
if ~exist(vec_dir, 'dir'), mkdir(vec_dir); end
fprintf('  输出目录: %s\n', vec_dir);

num_tests = 5;
SNR_db = 3.0;  % 高 SNR 确保正确译码
max_retry = 20;

for t = 1:num_tests
    % 浮点译码必须成功才可作为期望值; 失败则重抽, 耗尽重试次数即报错退出。
    % 原实现用 continue 直接跳过, 会静默少导出一组向量而不报错 ——
    % TB 随后加载到空文件, 属"缺证据却看似正常"的假绿路径。
    ok = false;
    for attempt = 1:max_retry
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
        if isequal(dec_float, info)
            ok = true;
            break;
        end
        fprintf('  Test %d: 浮点译码未收敛 (第 %d 次), 重抽\n', t, attempt);
    end
    if ~ok
        error('gen_rtl_test_vectors:floatDecodeFailed', ...
              'Test %d 在 %d 次重试后仍无法产生可用向量 —— 拒绝导出不完整向量集', t, max_retry);
    end

    % 写入文件
    llr_path = fullfile(vec_dir, sprintf('tb_llr_input_%d.hex', t));
    exp_path = fullfile(vec_dir, sprintf('tb_expected_output_%d.hex', t));
    fid_llr = fopen(llr_path, 'w');
    fid_exp = fopen(exp_path, 'w');
    if fid_llr < 0 || fid_exp < 0
        error('gen_rtl_test_vectors:openFailed', '无法写入向量文件: %s', vec_dir);
    end

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
