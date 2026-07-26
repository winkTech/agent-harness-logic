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

% 向量数须让 G-B-03 的比对样点数过 2048 下限 (治理规范 §2.6):
% 每组 K=324 bit, 5 组只有 1620, 达不到判据。10 组 = 3240。
num_tests = 10;
SNR_db = 3.0;  % 高 SNR 确保正确译码
max_retry = 20;

% RTL 侧定点参数 (须与 incubator/intake/ldpc_codec/rtl/ldpc_defines.vh 一致):
%   P_Q_DATA_W=10, P_Q_FRAC=4, P_ALPHA_FIXED=12/16=0.75, P_MAX_ITER=20
% internal_bits 必须显式给 10, 不能用 ldpc_decoder_ms_fixed 的默认值。
% 该函数默认 internal_bits = total_bits + 2 = 12 -> 饱和到 ±2047/-2048;
% 而设计规格 knowledge/primary/domains/comm/ldpc/stage3_fixed_point_report.md §6
% 明确写 Q(10,4) 的"饱和策略 = 对称饱和到 [-512, 511]", 即 internal = 10,
% 与 RTL 的 P_Q_DATA_W=10 一致。用默认值会让 golden 的数据通路比 RTL 宽 2 位,
% bit-true 永远对不上, 且症状是"大信号处偶发不符", 极难定位。
RTL_MAX_ITER = 20;
q_config = struct('total_bits', 10, 'frac_bits', 4, 'internal_bits', 10);

for t = 1:num_tests
    % 期望值必须同时满足两件事, 缺一不可:
    %   (1) 浮点译码器能恢复 info —— 说明这组向量本身可译, 不是信道太差;
    %   (2) **定点** golden (ldpc_decoder_ms_fixed, 即 manifest 指定的 bit-true
    %       对标基准) 在 RTL 的 Q(10,4)/20 迭代下也能恢复 info。
    % 只验 (1) 会埋一个坑: 某组向量浮点可译、定点在 20 迭代内不收敛时,
    % info 就成了正确 RTL 也达不到的期望值 —— 表现为"实现没错但测试过不了",
    % 而排查方向会被引到 RTL 上。这里让生成阶段就把这种向量筛掉。
    %
    % 失败则重抽, 耗尽重试次数即报错退出。原实现用 continue 直接跳过,
    % 会静默少导出一组向量而不报错 —— TB 随后加载到空文件, 属假绿路径。
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

        % (1) 浮点译码验证
        dec_float = ldpc_decoder_ms_pure(llr_float, H, 50, 0.75);
        if ~isequal(dec_float, info)
            fprintf('  Test %d: 浮点译码未收敛 (第 %d 次), 重抽\n', t, attempt);
            continue;
        end

        % (2) 定点 golden 在 RTL 参数下的可达性验证
        dec_fixed = ldpc_decoder_ms_fixed(llr_float, H, RTL_MAX_ITER, 0.75, q_config);
        if ~isequal(dec_fixed(:), info(:))
            nerr = sum(dec_fixed(:) ~= info(:));
            fprintf('  Test %d: 定点 golden 在 %d 迭代内未收敛 (%d bit 错, 第 %d 次), 重抽\n', ...
                t, RTL_MAX_ITER, nerr, attempt);
            continue;
        end

        ok = true;
        break;
    end
    if ~ok
        error('gen_rtl_test_vectors:decodeFailed', ...
              'Test %d 在 %d 次重试后仍无法产生浮点与定点双双可译的向量 —— 拒绝导出不完整向量集', ...
              t, max_retry);
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
