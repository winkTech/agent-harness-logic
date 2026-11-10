%% ===========================================================================
%  <算法名称> 一键回归测试
%  运行所有测试用例，输出 PASS/FAIL 汇总
% ============================================================================

clear; clc; close all;
addpath(genpath('src'));
addpath(genpath('tests'));

%% 测试用例列表
tests = {
    @test_normal,      '常规数据'
    @test_boundary,    '边界条件'
    @test_overflow,    '溢出测试'
    @test_performance  '性能基线'
};

%% 运行
fprintf('========================================\n');
fprintf('  <算法名称> 回归测试\n');
fprintf('========================================\n\n');

total   = length(tests);
passed  = 0;
failed  = 0;

for i = 1:total
    func = tests{i, 1};
    name = tests{i, 2};

    try
        result = func();
        if result
            fprintf('[PASS] %s\n', name);
            passed = passed + 1;
        else
            fprintf('[FAIL] %s\n', name);
            failed = failed + 1;
        end
    catch ME
        fprintf('[FAIL] %s — 异常: %s\n', name, ME.message);
        failed = failed + 1;
    end
end

%% 汇总
fprintf('\n========================================\n');
fprintf('  完成: %d/%d PASS, %d FAIL\n', passed, total, failed);
fprintf('========================================\n');

if failed > 0
    error('回归测试未通过');
end
