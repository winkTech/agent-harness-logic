function symbols = mod_mapper(bits, mod_type)
%MOD_MAPPER  调制映射 (Modulation Mapper)
%
%  输入:
%    bits     - 比特流, 列向量 [N_bits x 1]
%    mod_type - 调制方式: 'BPSK' | 'QPSK' | '16QAM' | '64QAM'
%  输出:
%    symbols  - 调制符号, 列向量 [N_sym x 1], 平均功率归一化 = 1
%
%  16QAM/64QAM: I/Q 路分别 Gray 编码为 M-PAM 符号
%
%  修复记录 (2026-06-03):
%    - 修复嵌套 qam_gray_map 函数覆盖问题 (MATLAB 只保留最后一个定义)
%    - 修复 Gray 编码 bit 索引错误 (bits{i} 应为 bits(1,:) 等行向量)
%    - 改为单一 nargin-dispatch 函数 + 正确的 Gray-to-binary 转换

    validateattributes(bits, {'numeric'}, {'column', 'binary'}, mfilename, 'bits');

    switch mod_type
        case 'BPSK'
            symbols = 2 * double(bits) - 1;

        case 'QPSK'
            N = floor(length(bits) / 2);
            bits = bits(1:2*N);
            bits_i = bits(1:2:end);
            bits_q = bits(2:2:end);
            symbols = (2*double(bits_i) - 1 + ...
                       1j*(2*double(bits_q) - 1)) / sqrt(2);

        case '16QAM'
            N = floor(length(bits) / 4);
            bits = bits(1:4*N);
            bits_r = reshape(double(bits), 4, N);
            I = qam_gray_map(bits_r(1,:), bits_r(2,:), 4);
            Q = qam_gray_map(bits_r(3,:), bits_r(4,:), 4);
            symbols = (I + 1j*Q) / sqrt(10);

        case '64QAM'
            N = floor(length(bits) / 6);
            bits = bits(1:6*N);
            bits_r = reshape(double(bits), 6, N);
            I = qam_gray_map(bits_r(1,:), bits_r(2,:), bits_r(3,:), 8);
            Q = qam_gray_map(bits_r(4,:), bits_r(5,:), bits_r(6,:), 8);
            symbols = (I + 1j*Q) / sqrt(42);

        otherwise
            error('mod_mapper: 不支持的调制方式: %s', mod_type);
    end

    symbols = symbols(:);
end

% ===== 单一 qam_gray_map (nargin 自动区分 2-bit/3-bit PAM) =====
function y = qam_gray_map(varargin)
% Gray 编码 M-PAM 映射
%   y = qam_gray_map(b0, b1, M)       % 2-bit PAM (M=4), 用于 16QAM
%   y = qam_gray_map(b0, b1, b2, M)   % 3-bit PAM (M=8), 用于 64QAM
%
%  Gray 映射规则:
%   4-PAM: 00→-3, 01→-1, 11→+1, 10→+3
%   8-PAM: 000→-7, 001→-5, 011→-3, 010→-1, 110→+1, 111→+3, 101→+5, 100→+7

    if nargin == 3
        b0 = varargin{1}; b1 = varargin{2}; M = varargin{3};
        map = [-3, -1, 1, 3];
        % Gray→binary: bin0=g0, bin1=xor(g0,g1)
        idx = b0 * 2 + xor(b0, b1) + 1;
        y = map(idx);
    elseif nargin == 4
        b0 = varargin{1}; b1 = varargin{2}; b2 = varargin{3}; M = varargin{4};
        map = [-7, -5, -3, -1, 1, 3, 5, 7];
        % Gray→binary: bin0=g0, bin1=xor(g0,g1), bin2=xor(bin1,g2)
        bin1 = xor(b0, b1);
        bin2 = xor(bin1, b2);
        idx = b0 * 4 + bin1 * 2 + bin2 + 1;
        y = map(idx);
    else
        error('qam_gray_map: 需要 3 或 4 个输入参数');
    end
end
