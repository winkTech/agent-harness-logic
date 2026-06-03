%% ===========================================================================
%  RRC 成形滤波器 — 一键回归测试
%  运行所有测试用例，输出 PASS/FAIL 汇总
% ============================================================================

clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));

%% 测试用例列表
tests = {
    @test_normal,          '常规数据 — QPSK 成形 + EVM'
    @test_modulations,     '多调制方式 — 16QAM/64QAM'
    @test_boundary,        '边界条件 — 滚降系数 0.22/0.35/0.5'
    @test_quantization,    '定点量化 — 12位/16位系数对比'
    @test_impulse_response '冲激响应 — 验证 ISI 特性'
};

%% 运行
fprintf('============================================\n');
fprintf('  RRC 成形滤波器 回归测试\n');
fprintf('============================================\n\n');

total   = length(tests);
passed  = 0;
failed  = 0;
results = {};

for i = 1:total
    func = tests{i, 1};
    name = tests{i, 2};

    fprintf('[%d/%d] %s ... ', i, total, name);

    try
        [result, detail] = func();
        if result
            fprintf('PASS');
            if ~isempty(detail)
                fprintf(' (%s)', detail);
            end
            fprintf('\n');
            passed = passed + 1;
            results{i} = struct('name', name, 'pass', true, 'detail', detail);
        else
            fprintf('FAIL (%s)\n', detail);
            failed = failed + 1;
            results{i} = struct('name', name, 'pass', false, 'detail', detail);
        end
    catch ME
        fprintf('FAIL — 异常: %s\n', ME.message);
        failed = failed + 1;
        results{i} = struct('name', name, 'pass', false, 'detail', ME.message);
    end
end

%% 汇总
fprintf('\n============================================\n');
fprintf('  完成: %d/%d PASS, %d FAIL\n', passed, total, failed);
fprintf('============================================\n');

if failed > 0
    fprintf('\n失败详情:\n');
    for i = 1:length(results)
        if ~results{i}.pass
            fprintf('  - %s: %s\n', results{i}.name, results{i}.detail);
        end
    end
    error('回归测试未通过: %d 个失败', failed);
end
