%% OFDM 黄金模型 一键回归测试
clear; clc; close all;
addpath('src');
addpath('tests');

tests = {
    @test_ber,          'BER测试(理想信道)'
    @test_modulations,  '多调制方式测试'
    @test_boundary,     '边界条件测试'
    @test_fft_chain,    'FFT 变换级 (正向, 与 ifft_chain 互逆)'
    @test_fft64_mirror, 'fft64 定点镜像 (反验 + 溢出判定)'
    @test_rx_cp_window,  '帧结构切窗 (cp_remove 锚)'
    @test_eq_zf,        'ZF 频域均衡 + 数据子载波提取 (均衡器锚)'
    @test_eq_mirror,    'eq_zf 定点位真镜像 (对浮点 2304 点 + 除零/饱和/归一化边界)'
    @test_mod_demapper_llr, '软判决解调 max-log LLR (解调器锚, 对硬判决 0 比特差异)'
    @test_rtl_mirror_demap, 'mod_demapper 定点位真镜像 (对浮点锚 Q(10,4) 地板 + 擦除/饱和/位宽)'
};

fprintf('========================================\n');
fprintf('  OFDM 黄金模型回归测试\n');
fprintf('========================================\n\n');

total = length(tests);
passed = 0;
failed = 0;

for i = 1:total
    func = tests{i,1};
    name = tests{i,2};
    try
        result = func();
        if result
            fprintf('  [PASS] %s\n\n', name);
            passed = passed + 1;
        else
            fprintf('  [FAIL] %s\n\n', name);
            failed = failed + 1;
        end
    catch ME
        fprintf('  [FAIL] %s — %s\n\n', name, ME.message);
        failed = failed + 1;
    end
end

fprintf('========================================\n');
fprintf('  完成: %d/%d PASS, %d FAIL\n', passed, total, failed);
fprintf('========================================\n');
